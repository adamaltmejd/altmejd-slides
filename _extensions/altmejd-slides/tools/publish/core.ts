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

export function workerName(slug: string): string {
  return `${WORKER_PREFIX}${slug}`;
}

// The exact pattern lets Cloudflare's own asset handling 307 /slug to /slug/;
// the gateway redirect remains only a fallback for unpublished paths.
export function routePatterns(host: string, slug: string): string[] {
  return [`${host}/${slug}`, `${host}/${slug}/*`];
}

const REF_ATTRIBUTE =
  /\s(?:src|href|data-src|poster|data-background-image)\s*=\s*("[^"]*"|'[^']*')/g;
const SRCSET_ATTRIBUTE = /\s(?:srcset|data-srcset)\s*=\s*("[^"]*"|'[^']*')/g;

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
  return ref
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

// Collect local relative references from rendered HTML: src/href/poster,
// Reveal data-src and data-background-image, and srcset candidate URLs.
export function collectAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string) => {
    const ref = stripQueryAndFragment(decodeEntities(raw.trim()));
    if (isLocalRelative(ref) && ref !== "") {
      refs.add(ref);
    }
  };
  for (const match of html.matchAll(REF_ATTRIBUTE)) {
    add(match[1].slice(1, -1));
  }
  for (const match of html.matchAll(SRCSET_ATTRIBUTE)) {
    for (const candidate of match[1].slice(1, -1).split(",")) {
      add(candidate.trim().split(/\s+/, 1)[0]);
    }
  }
  return [...refs].sort();
}

export interface StagingPlan {
  // Top-level directories to copy wholesale (e.g. deck_files, assets).
  directories: string[];
  // Individual top-level files to copy.
  files: string[];
  // References that escape the deck directory and cannot be published.
  outside: string[];
}

// Referenced directories are copied wholesale because CSS inside them loads
// fonts and images the HTML scan cannot see.
export function planStaging(refs: readonly string[]): StagingPlan {
  const directories = new Set<string>();
  const files = new Set<string>();
  const outside = new Set<string>();
  for (const ref of refs) {
    const normalized = ref.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) {
      outside.add(ref);
      continue;
    }
    const slash = normalized.indexOf("/");
    if (slash === -1) {
      files.add(normalized);
    } else {
      directories.add(normalized.slice(0, slash));
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
