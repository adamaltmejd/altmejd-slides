// Pure publishing logic for the Cloudflare publisher. No Deno or Node APIs so
// the module can be exercised by bun tests while the Deno entry point
// (../publish-cloudflare.ts) supplies all filesystem and subprocess effects.

export const WORKER_PREFIX = "altmejd-slides-";
export const GATEWAY_WORKER = "altmejd-slides-gateway";
export const COMPATIBILITY_DATE = "2026-08-01";
export const DEFAULT_HOST = "slides.altmejd.se";

// Slugs become Worker names (altmejd-slides-<slug> must stay under Cloudflare's
// 63-character Worker name limit) and public path segments.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,44}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(["index", "gateway", "assets"]);

export interface CloudflareTarget {
  host: string;
  zone: string;
  slug: string;
}

export interface ResolveError {
  error: string;
}

export function sanitizeSlug(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function validateSlug(slug: string): string | null {
  if (!SLUG_PATTERN.test(slug)) {
    return `invalid slug "${slug}": use 1-46 lowercase letters, digits, or interior hyphens`;
  }
  if (RESERVED_SLUGS.has(slug)) {
    return `slug "${slug}" is reserved`;
  }
  return null;
}

export function deriveZone(host: string): string | null {
  const labels = host.split(".");
  if (labels.length < 3 || labels.some((label) => label.length === 0)) {
    return null;
  }
  return labels.slice(1).join(".");
}

interface RawCloudflareMeta {
  host?: unknown;
  zone?: unknown;
  slug?: unknown;
}

export interface ResolveTargetInput {
  metadata: RawCloudflareMeta | undefined;
  cliSlug: string | undefined;
  // Default slug source: the deck repository's directory name.
  projectName: string;
}

// Precedence: --slug flag, then YAML slug, then the sanitized repository name.
// The host defaults to slides.altmejd.se unless the YAML overrides it.
export function resolveTarget(input: ResolveTargetInput): CloudflareTarget | ResolveError {
  const meta = input.metadata ?? {};
  const rawHost = typeof meta.host === "string" ? meta.host.trim() : "";
  const host = rawHost === "" ? DEFAULT_HOST : rawHost;
  let zone = typeof meta.zone === "string" ? meta.zone.trim() : "";
  if (zone === "") {
    const derived = deriveZone(host);
    if (derived === null) {
      return {
        error: `cannot derive a Cloudflare zone from host "${host}": set publish.cloudflare.zone`,
      };
    }
    zone = derived;
  }
  if (host !== zone && !host.endsWith(`.${zone}`)) {
    return { error: `host "${host}" is not inside zone "${zone}"` };
  }
  const rawSlug = input.cliSlug ?? (typeof meta.slug === "string" ? meta.slug.trim() : undefined);
  const slug = rawSlug ?? sanitizeSlug(input.projectName);
  if (slug === "") {
    return { error: `cannot derive a slug from "${input.projectName}": pass --slug` };
  }
  const slugError = validateSlug(slug);
  if (slugError !== null) {
    return { error: slugError };
  }
  return { host, zone, slug };
}

// Resolve which QMD is the deck. Explicit --input wins; otherwise the project
// must contain exactly one QMD so publishing stays unambiguous.
export function resolveInput(
  qmdFiles: readonly string[],
  cliInput: string | undefined,
): string | ResolveError {
  if (cliInput !== undefined) {
    return cliInput;
  }
  if (qmdFiles.length === 1) {
    return qmdFiles[0];
  }
  if (qmdFiles.length === 0) {
    return { error: "no .qmd file found in this directory: pass --input <deck.qmd>" };
  }
  return {
    error:
      `multiple .qmd files found (${qmdFiles.join(", ")}): ` +
      "pass --input <deck.qmd> to choose the deck",
  };
}

export interface PublishArtifact {
  name: string;
  source: string;
  target: string;
}

const TARGET_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Extra files published beside the deck, e.g. a slides PDF. Every artifact is
// individually opted in through configuration; nothing is published
// implicitly. Targets are validated as safe relative paths under the slug.
export function resolveArtifacts(raw: unknown): PublishArtifact[] | ResolveError {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "publish.cloudflare.artifacts must be a mapping of name to {source, target}" };
  }
  const artifacts: PublishArtifact[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = (value ?? {}) as Record<string, unknown>;
    const source = typeof entry.source === "string" ? entry.source.trim() : "";
    if (source === "") {
      return { error: `artifact "${name}" needs a source path` };
    }
    if (source.startsWith("/") || source.split(/[/\\]/).includes("..")) {
      return { error: `artifact "${name}" source must be a relative path inside the project` };
    }
    const fallback = source.split(/[/\\]/).pop() ?? "";
    const target = typeof entry.target === "string" ? entry.target.trim() : fallback;
    const segments = target.split("/");
    if (target === "" || !segments.every((segment) => TARGET_SEGMENT.test(segment))) {
      return {
        error:
          `artifact "${name}" target "${target}" is invalid: ` +
          "use relative path segments of letters, digits, dot, dash, underscore",
      };
    }
    if (target === "index.html") {
      return { error: `artifact "${name}" target may not replace the deck's index.html` };
    }
    artifacts.push({ name, source, target });
  }
  return artifacts.sort((a, b) => a.name.localeCompare(b.name));
}

export function workerName(slug: string): string {
  return `${WORKER_PREFIX}${slug}`;
}

// The exact pattern lets Cloudflare's own asset handling 307 /slug to /slug/;
// the gateway redirect remains only a fallback for unpublished paths.
export function routePatterns(host: string, slug: string): string[] {
  return [`${host}/${slug}`, `${host}/${slug}/*`];
}

const REF_ATTRIBUTES = new Set([
  "src",
  "href",
  "data-src",
  "poster",
  "data-background-image",
  "data-background-video",
  "data-background-iframe",
]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "data-srcset"]);
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript", // Reveal decks run with scripting enabled.
]);
const HTML_SPACE = /[\t\n\f\r ]/;
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

interface ValueSpan {
  start: number;
  end: number;
}

interface HtmlAttribute extends ValueSpan {
  name: string;
}

// Read attribute value offsets, never matching attribute-like text inside a
// different value. An unfinished tag is not emitted by the HTML tokenizer.
function readHtmlTag(html: string, start: number) {
  const name = /<\/?([a-zA-Z][^\t\n\f\r />]*)/y;
  name.lastIndex = start;
  const match = name.exec(html);
  if (match === null) return null;
  let pos = name.lastIndex;
  const attributes: HtmlAttribute[] = [];
  const seen = new Set<string>();
  while (pos < html.length) {
    const separatorStart = pos;
    while (HTML_SPACE.test(html[pos]) || html[pos] === "/") pos++;
    if (html[pos] === ">") {
      return {
        name: match[1].toLowerCase(),
        end: pos + 1,
        attributes,
        selfClosing: pos > separatorStart && html[pos - 1] === "/",
      };
    }
    if (pos >= html.length) break;
    const nameStart = pos++;
    while (pos < html.length && !/[\t\n\f\r /=>]/.test(html[pos])) pos++;
    const attributeName = html.slice(nameStart, pos).toLowerCase();
    while (HTML_SPACE.test(html[pos])) pos++;
    if (html[pos] === "=") {
      pos++;
      while (HTML_SPACE.test(html[pos])) pos++;
      const quote = html[pos];
      let valueStart = pos;
      let valueEnd: number;
      if (quote === '"' || quote === "'") {
        valueStart = ++pos;
        valueEnd = html.indexOf(quote, pos);
        if (valueEnd === -1) return null;
        pos = valueEnd + 1;
      } else {
        while (pos < html.length && !/[\t\n\f\r >]/.test(html[pos])) pos++;
        valueEnd = pos;
      }
      if (!seen.has(attributeName)) {
        attributes.push({ name: attributeName, start: valueStart, end: valueEnd });
      }
    }
    seen.add(attributeName);
  }
  return null;
}

function rawTextEnd(html: string, name: string, start: number): number {
  if (name !== "script") {
    const close = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
    close.lastIndex = start;
    return close.exec(html)?.index ?? html.length;
  }
  // In legacy comment-wrapped scripts, <script> can double-escape the body:
  // the next </script> then returns to escaped script data instead of closing.
  const tokens = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  tokens.lastIndex = start;
  let state: "data" | "escaped" | "double-escaped" = "data";
  for (let token = tokens.exec(html); token !== null; token = tokens.exec(html)) {
    const text = token[0].toLowerCase();
    if (text === "<!--" && state === "data") state = "escaped";
    else if (text === "-->") state = "data";
    else if (text === "<script" && state === "escaped") state = "double-escaped";
    else if (text === "</script") {
      if (state !== "double-escaped") return token.index;
      state = "escaped";
    }
  }
  return html.length;
}

// Scan rendered HTML without serializing it: only real opening-tag attributes
// may change. Comments, raw text, and all intervening bytes stay untouched.
function* htmlAttributes(html: string): Generator<HtmlAttribute> {
  // Foreign elements have different text and self-closing rules. Track their
  // nesting and HTML integration points (e.g. SVG foreignObject), so an inline
  // <svg><style/></svg> cannot consume the HTML following it as raw text.
  const elements: { name: string; namespace: string; htmlChildren: boolean }[] = [];
  let pos = 0;
  while (pos < html.length) {
    pos = html.indexOf("<", pos);
    if (pos === -1) return;
    if (html.startsWith("<!--", pos)) {
      const end = /--!?>/g;
      end.lastIndex = pos + 4;
      if (html[pos + 4] === ">") pos += 5;
      else if (html.startsWith("->", pos + 4)) pos += 6;
      else pos = end.exec(html) === null ? html.length : end.lastIndex;
      continue;
    }
    if (
      html.startsWith("<![CDATA[", pos) &&
      elements.length > 0 &&
      elements.at(-1)?.namespace !== "html"
    ) {
      const end = html.indexOf("]]>", pos + 9);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    if (
      /^<[!?]/.test(html.slice(pos, pos + 2)) ||
      (html.startsWith("</", pos) && !/[a-zA-Z>]/.test(html[pos + 2] ?? ""))
    ) {
      const end = html.indexOf(">", pos + 2);
      pos = end === -1 ? html.length : end + 1;
      continue;
    }
    if (!/^<\/?[a-zA-Z]/.test(html.slice(pos, pos + 3))) {
      pos++;
      continue;
    }
    const closing = html[pos + 1] === "/";
    const tag = readHtmlTag(html, pos);
    if (tag === null) return;
    pos = tag.end;
    if (closing) {
      const index = elements.findLastIndex((element) => element.name === tag.name);
      if (index !== -1) elements.length = index;
      continue;
    }
    yield* tag.attributes;
    const parent = elements.at(-1);
    let namespace = parent?.namespace ?? "html";
    if (
      parent?.htmlChildren &&
      !(
        parent.namespace === "math" &&
        parent.name !== "annotation-xml" &&
        ["mglyph", "malignmark"].includes(tag.name)
      )
    ) {
      namespace = "html";
    }
    if (
      (namespace === "html" && (tag.name === "svg" || tag.name === "math")) ||
      (parent?.namespace === "math" && parent.name === "annotation-xml" && tag.name === "svg")
    ) {
      namespace = tag.name;
    }
    const htmlChildren =
      (namespace === "svg" && ["foreignobject", "desc", "title"].includes(tag.name)) ||
      (namespace === "math" &&
        (["mi", "mo", "mn", "ms", "mtext"].includes(tag.name) ||
          (tag.name === "annotation-xml" &&
            tag.attributes.some(
              (attr) =>
                attr.name === "encoding" &&
                /^(text\/html|application\/xhtml\+xml)$/i.test(html.slice(attr.start, attr.end)),
            ))));
    if (namespace === "html") {
      if (!HTML_VOID_ELEMENTS.has(tag.name)) elements.push({ ...tag, namespace, htmlChildren });
      if (tag.name === "plaintext") return;
      if (RAW_TEXT_ELEMENTS.has(tag.name)) pos = rawTextEnd(html, tag.name, pos);
    } else if (!tag.selfClosing) {
      elements.push({ ...tag, namespace, htmlChildren });
    }
  }
}

// A srcset URL ends at whitespace, not at an internal comma (e.g. data URLs).
// Trailing commas end candidates; commas in parenthesized descriptors do not.
function* srcsetUrls(value: string): Generator<ValueSpan> {
  let pos = 0;
  while (pos < value.length) {
    while (HTML_SPACE.test(value[pos]) || value[pos] === ",") pos++;
    const start = pos;
    while (pos < value.length && !HTML_SPACE.test(value[pos])) pos++;
    let end = pos;
    while (end > start && value[end - 1] === ",") end--;
    if (end > start) yield { start, end };
    if (end < pos) continue;
    let parentheses = false;
    while (pos < value.length) {
      const char = value[pos++];
      if (char === "," && !parentheses) break;
      if (char === "(") parentheses = true;
      if (char === ")") parentheses = false;
    }
  }
}

function* assetRefSpans(html: string): Generator<ValueSpan> {
  for (const attribute of htmlAttributes(html)) {
    if (REF_ATTRIBUTES.has(attribute.name)) {
      yield attribute;
    } else if (SRCSET_ATTRIBUTES.has(attribute.name)) {
      for (const span of srcsetUrls(html.slice(attribute.start, attribute.end))) {
        yield { start: attribute.start + span.start, end: attribute.start + span.end };
      }
    }
  }
}

function isLocalRelative(ref: string): boolean {
  if (ref === "" || ref.startsWith("#") || ref.startsWith("/") || ref.startsWith("\\")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) {
    return false; // http:, https:, data:, mailto:, tel:, ...
  }
  return true;
}

function stripQueryAndFragment(ref: string): string {
  return ref.split("#", 1)[0].split("?", 1)[0];
}

function decodeEntities(ref: string): string {
  // &amp; last, so &amp;quot; does not double-decode.
  return ref
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Pandoc percent-encodes URLs (a space becomes %20); staged files keep their
// real names and Cloudflare decodes request paths before asset lookup, so
// references are compared and staged in decoded form. Decode after stripping
// the query/fragment so an encoded "?" or "#" stays part of the filename.
function decodePercent(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

// Collect local relative references from rendered HTML: src/href/poster,
// Reveal data-src and data-background-image, and srcset candidate URLs.
export function collectAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string) => {
    const ref = decodePercent(stripQueryAndFragment(decodeEntities(raw.trim())));
    if (isLocalRelative(ref) && ref !== "") {
      refs.add(ref);
    }
  };
  for (const span of assetRefSpans(html)) {
    add(html.slice(span.start, span.end));
  }
  return [...refs].sort();
}

// Relocating the entry HTML to /<slug>/ must preserve references from nested
// output directories. Leave URL encoding, query strings, and anchors intact.
export function rebaseAssetRefs(html: string, entryPath: string): string {
  const directory = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
  const rebase = (raw: string): string => {
    const decoded = decodeEntities(raw.trim());
    if (!isLocalRelative(decoded)) {
      return raw;
    }
    const path = decodePercent(stripQueryAndFragment(decoded));
    const resolved = resolveStagingRef(path, directory);
    if (resolved === null) {
      return raw; // The staging preflight reports escapes before writing HTML.
    }
    const suffix = decoded.slice(stripQueryAndFragment(decoded).length);
    const target = resolved === entryPath ? "index.html" : resolved;
    return (target.split("/").map(encodeURIComponent).join("/") + suffix)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };
  const parts: string[] = [];
  let copied = 0;
  for (const span of assetRefSpans(html)) {
    const value = html.slice(span.start, span.end);
    const rebased = rebase(value);
    if (rebased !== value) {
      parts.push(html.slice(copied, span.start), rebased);
      copied = span.end;
    }
  }
  parts.push(html.slice(copied));
  return parts.join("");
}

const CSS_URL = /url\(\s*("[^"]*"|'[^']*'|[^"')][^)]*)\s*\)/gi;
const CSS_IMPORT = /@import\s+("[^"]*"|'[^']*')/gi;

// Collect local relative url() and @import references. The caller resolves
// them against each stylesheet's directory, never the entry HTML's directory.
export function collectCssRefs(css: string): string[] {
  css = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const refs = new Set<string>();
  const add = (raw: string) => {
    let value = raw.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      value = value.slice(1, -1);
    }
    const ref = decodePercent(stripQueryAndFragment(value.trim()));
    if (isLocalRelative(ref) && ref !== "") {
      refs.add(ref);
    }
  };
  for (const match of css.matchAll(CSS_URL)) {
    add(match[1]);
  }
  for (const match of css.matchAll(CSS_IMPORT)) {
    add(match[1]);
  }
  return [...refs].sort();
}

export interface StagingPlan {
  // Asset directories to copy wholesale (e.g. talks/deck_files, site_libs).
  directories: string[];
  // Individual files, relative to the rendered output root.
  files: string[];
  // References that escape the deck directory and cannot be published.
  outside: string[];
}

function normalizeRelativeRef(ref: string): string[] {
  const parts: string[] = [];
  for (const part of ref.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts;
}

export function resolveStagingRef(ref: string, directory = ""): string | null {
  if (!isLocalRelative(ref)) {
    return null;
  }
  const parts = normalizeRelativeRef(directory === "" ? ref : `${directory}/${ref}`);
  return parts.length === 0 || parts[0] === ".." ? null : parts.join("/");
}

// Referenced directories are copied wholesale because CSS inside them loads
// fonts and images the HTML scan cannot see.
export function planStaging(refs: readonly string[], directory = ""): StagingPlan {
  const directories = new Set<string>();
  const files = new Set<string>();
  const outside = new Set<string>();
  for (const ref of refs) {
    const normalized = resolveStagingRef(ref, directory);
    const parts = normalizeRelativeRef(ref);
    while (parts[0] === "..") {
      parts.shift();
    }
    if (normalized === null || parts.length === 0) {
      outside.add(ref);
      continue;
    }
    if (parts.length === 1 && !ref.endsWith("/")) {
      files.add(normalized);
    } else {
      const baseParts = normalized.split("/");
      directories.add(baseParts.slice(0, baseParts.length - parts.length + 1).join("/"));
    }
  }
  return {
    directories: [...directories].sort(),
    files: [...files].sort(),
    outside: [...outside].sort(),
  };
}

// Wrangler configuration for one deck Worker. Paths are relative to the
// generated config file, which sits next to the staged public/ directory.
export function deckWranglerConfig(target: CloudflareTarget): Record<string, unknown> {
  return {
    name: workerName(target.slug),
    main: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    assets: { directory: "./public" },
    workers_dev: false,
    routes: routePatterns(target.host, target.slug).map((pattern) => ({
      pattern,
      zone_name: target.zone,
    })),
  };
}

// Runs only for requests below /<slug>/ that match no uploaded asset.
export function deckWorkerScript(slug: string): string {
  return [
    "export default {",
    "  fetch() {",
    `    return new Response("Not found in deck ${slug}.\\n", {`,
    "      status: 404,",
    '      headers: { "content-type": "text/plain; charset=utf-8" },',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
}

export function gatewayWranglerConfig(host: string, zone: string): Record<string, unknown> {
  return {
    name: GATEWAY_WORKER,
    main: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    workers_dev: false,
    routes: [{ pattern: host, custom_domain: true }],
    vars: { PUBLISH_HOST: host, PUBLISH_ZONE: zone },
  };
}

// Fallback for requests no deck route claims: redirect bare /slug to /slug/
// so an unpublished-then-published deck URL works, otherwise 404.
export function gatewayWorkerScript(): string {
  return [
    "export default {",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    '    if (url.pathname === "/") {',
    '      return new Response("Nothing published at the root of this host.\\n", {',
    "        status: 404,",
    '        headers: { "content-type": "text/plain; charset=utf-8" },',
    "      });",
    "    }",
    "    if (/^\\/[a-z0-9][a-z0-9-]*$/.test(url.pathname)) {",
    '      return Response.redirect(url.origin + url.pathname + "/" + url.search, 308);',
    "    }",
    '    return new Response("No such talk.\\n", {',
    "      status: 404,",
    '      headers: { "content-type": "text/plain; charset=utf-8" },',
    "    });",
    "  },",
    "};",
    "",
  ].join("\n");
}

export function publicUrl(target: CloudflareTarget): string {
  return `https://${target.host}/${target.slug}/`;
}

// Presentations get viewed on unreliable venue networks. Cloudflare's default
// asset response (`max-age=0, must-revalidate`) demands a network round-trip
// for every view and forbids serving the cached copy when that trip fails, so
// even a previously-loaded figure can vanish mid-talk. stale-while-revalidate
// keeps content fresh (every view still revalidates in the background) while
// letting the browser serve — and keep — its cached copy when the network
// drops a request.
export function headersFileContent(): string {
  return ["/*", "  Cache-Control: public, max-age=0, stale-while-revalidate=604800", ""].join("\n");
}
