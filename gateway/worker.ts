import { validateSlug } from "../_extensions/altmejd-slides/tools/publish/core";

const FRESH_MS = 5 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_API_BYTES = 2 * 1024 * 1024;

interface Snapshot {
  slugs: string[];
  fetchedAt: number;
}

function publishHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
  ) {
    throw new Error("Invalid gateway host");
  }
  return host;
}

function config(env: Env) {
  const zoneId = env.CLOUDFLARE_ZONE_ID;
  const prefix = env.WORKER_PREFIX;
  if (
    typeof zoneId !== "string" ||
    !/^[a-f0-9]{32}$/i.test(zoneId) ||
    typeof prefix !== "string" ||
    !/^[a-z][a-z0-9-]{0,60}-$/.test(prefix) ||
    typeof env.INDEX_TITLE !== "string" ||
    env.INDEX_TITLE.trim().length === 0 ||
    env.INDEX_TITLE.length > 200 ||
    typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
    env.CLOUDFLARE_API_TOKEN.trim().length === 0
  ) {
    throw new Error("Invalid gateway configuration");
  }
  return { zoneId: zoneId.toLowerCase(), prefix, title: env.INDEX_TITLE.trim() };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugsFromRoutes(data: unknown, host: string, prefix: string): string[] {
  if (!isObject(data) || data.success !== true || !Array.isArray(data.result)) {
    throw new Error("Invalid route inventory");
  }
  const slugs = new Set<string>();
  for (const route of data.result) {
    if (
      !isObject(route) ||
      typeof route.pattern !== "string" ||
      (route.script != null && typeof route.script !== "string")
    ) {
      throw new Error("Invalid route record");
    }
    // Only the publisher's canonical HTTPS-capable prefix route establishes membership.
    const pattern = route.pattern.replace(/^https:\/\//, "");
    const slash = pattern.indexOf("/");
    if (pattern.slice(0, slash).toLowerCase() !== host) continue;
    const match = /^\/([^/]+)\/\*$/.exec(pattern.slice(slash));
    if (!match || validateSlug(match[1]) !== null) continue;
    const slug = match[1];
    if (route.script === prefix + slug && route.script.length <= 63) slugs.add(slug);
  }
  return [...slugs].sort();
}

async function readApiJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error("Route inventory unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_API_BYTES) {
        await reader.cancel();
        throw new Error("Route inventory too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function cachedSnapshot(value: unknown, now: number): Snapshot | null {
  if (
    !isObject(value) ||
    !Array.isArray(value.slugs) ||
    !value.slugs.every((slug) => typeof slug === "string" && validateSlug(slug) === null) ||
    typeof value.fetchedAt !== "number" ||
    !Number.isFinite(value.fetchedAt) ||
    value.fetchedAt > now ||
    now - value.fetchedAt >= RETAIN_MS
  ) {
    return null;
  }
  return { slugs: value.slugs, fetchedAt: value.fetchedAt };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, host: string, snapshot: Snapshot, stale: boolean): string {
  const updated = new Date(snapshot.fetchedAt).toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #302e30; background: #faf8f4; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 48rem; margin: 0 auto; padding: clamp(2rem, 8vw, 5rem) 1.5rem; }
    header { border-bottom: 2px solid #6d203b; padding-bottom: 1.75rem; }
    .host { color: #656066; font-size: .9rem; overflow-wrap: anywhere; }
    h1 { font-size: clamp(2.25rem, 7vw, 3.5rem); line-height: 1.1; margin: .75rem 0 0; overflow-wrap: anywhere; }
    ul { list-style: none; margin: 1.5rem 0; padding: 0; }
    li { border-bottom: 1px solid #ded8d8; }
    a { display: block; padding: 1rem 0; color: #6d203b; line-height: 1.5; text-underline-offset: .2em; overflow-wrap: anywhere; }
    a:hover { color: #302e30; }
    a:focus-visible { outline: 3px solid #6d203b; outline-offset: 4px; }
    p { line-height: 1.6; }
    .notice { padding: .75rem 1rem; border-left: 3px solid #6d203b; background: #f0e7e6; }
    footer { margin-top: 2.5rem; color: #656066; font-size: .85rem; }
  </style>
</head>
<body>
  <main>
    <header><div class="host">${escapeHtml(host)}</div><h1>${escapeHtml(title)}</h1></header>
    ${stale ? '<p class="notice">The list could not be refreshed. Showing the last available list.</p>' : ""}
    ${snapshot.slugs.length ? `<ul>${snapshot.slugs.map((slug) => `<li><a href="/${slug}/">${escapeHtml(slug)}</a></li>`).join("")}</ul>` : "<p>No slides are published here yet.</p>"}
    <footer>Updated <time datetime="${updated}">${updated.slice(0, 16).replace("T", " ")} UTC</time>. Changes may take a few minutes to appear.</footer>
  </main>
</body>
</html>`;
}

function reply(request: Request, body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

// Explicit dependencies keep the route API and cache failure paths testable without credentials.
export async function handleRequest(
  request: Request,
  env: Env,
  cache: Pick<Cache, "match" | "put">,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return reply(request, "Method not allowed.\n", 405, { allow: "GET, HEAD" });
  }
  const unavailable = () =>
    reply(request, "The slides list is temporarily unavailable. Please try again shortly.\n", 503, {
      "retry-after": "60",
    });
  let host: string;
  try {
    host = publishHost(env.PUBLISH_HOST);
  } catch {
    console.error(JSON.stringify({ event: "index_configuration_invalid" }));
    return unavailable();
  }
  const url = new URL(request.url);
  if (url.hostname !== host) {
    return reply(request, "Not found.\n", 404);
  }
  if (url.pathname !== "/") {
    if (/^\/[a-z0-9][a-z0-9-]*$/.test(url.pathname)) {
      return reply(request, "", 308, { location: `${url.origin}${url.pathname}/${url.search}` });
    }
    return reply(request, "No such talk.\n", 404);
  }
  let settings: ReturnType<typeof config>;
  try {
    settings = config(env);
  } catch {
    console.error(JSON.stringify({ event: "index_configuration_invalid" }));
    return unavailable();
  }
  const { zoneId, prefix, title } = settings;
  const cacheKey = `https://${host}/__slides-index-cache/v1/${zoneId}/${prefix}`;
  let snapshot: Snapshot | null = null;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) snapshot = cachedSnapshot(await cached.json(), now);
  } catch {
    console.error(JSON.stringify({ event: "index_cache_read_failed" }));
  }
  let stale = false;
  if (!snapshot || now - snapshot.fetchedAt >= FRESH_MS) {
    try {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`,
        {
          headers: {
            authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(5000),
          // Workerd supports manual/follow, not Fetch's redirect: "error".
          // readApiJson rejects 3xx without forwarding the API credential.
          redirect: "manual",
        },
      );
      const slugs = slugsFromRoutes(await readApiJson(response), host, prefix);
      snapshot = { slugs, fetchedAt: now };
    } catch {
      console.error(JSON.stringify({ event: "index_refresh_failed" }));
      if (!snapshot) return unavailable();
      stale = true;
    }
    if (!stale) {
      try {
        // The explicit fetchedAt check refreshes after five minutes. A longer cache
        // lifetime allows a retained result to survive a temporary API outage.
        await cache.put(
          cacheKey,
          Response.json(snapshot, { headers: { "cache-control": `max-age=${RETAIN_MS / 1000}` } }),
        );
      } catch {
        console.error(JSON.stringify({ event: "index_cache_write_failed" }));
      }
    }
  }
  return reply(request, page(title, host, snapshot, stale), 200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "referrer-policy": "strict-origin-when-cross-origin",
  });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env, caches.default);
  },
} satisfies ExportedHandler<Env>;
