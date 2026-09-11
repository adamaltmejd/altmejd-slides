import { describe, expect, test } from "bun:test";

import { handleRequest } from "../../gateway/worker";

const ENV = {
  PUBLISH_HOST: "talks.example.org",
  CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
  INDEX_TITLE: "Research talks",
  WORKER_PREFIX: "example-slides-",
  CLOUDFLARE_API_TOKEN: "test-read-only-token",
};
const NOW = Date.UTC(2026, 8, 10);
const MINUTE = 60_000;

function request(path = "/", method = "GET") {
  return new Request(`https://${ENV.PUBLISH_HOST}${path}`, { method });
}

function route(slug: string) {
  return { pattern: `${ENV.PUBLISH_HOST}/${slug}/*`, script: `${ENV.WORKER_PREFIX}${slug}` };
}

function routesResponse(slugs: string[]) {
  return Response.json({ success: true, result: slugs.map(route) });
}

function memoryCache(snapshot?: string) {
  const entries = new Map<string, Response>();
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    async match(key: RequestInfo | URL) {
      const stored = entries.get(key instanceof Request ? key.url : String(key));
      return stored?.clone() ?? (snapshot === undefined ? undefined : new Response(snapshot));
    },
    async put(key: RequestInfo | URL, value: Response) {
      writes++;
      entries.set(key instanceof Request ? key.url : String(key), value.clone());
    },
  };
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return response();
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("slides gateway", () => {
  test("lists only canonical routes for the configured host and Worker prefix", async () => {
    const accepted = [route("z-talk"), route("a-talk"), route("a-talk")];
    accepted.push({ ...route("secure"), pattern: `https://${ENV.PUBLISH_HOST}/secure/*` });
    const rejected = [
      { ...route("other-host"), pattern: "slides.altmejd.se/other-host/*" },
      { ...route("suffix-host"), pattern: `${ENV.PUBLISH_HOST}.evil.org/suffix-host/*` },
      { ...route("prefix-host"), pattern: `evil.${ENV.PUBLISH_HOST}/prefix-host/*` },
      { ...route("wildcard-host"), pattern: `*.${ENV.PUBLISH_HOST}/wildcard-host/*` },
      { ...route("http-only"), pattern: `http://${ENV.PUBLISH_HOST}/http-only/*` },
      { ...route("bare"), pattern: `${ENV.PUBLISH_HOST}/bare` },
      { ...route("nested"), pattern: `${ENV.PUBLISH_HOST}/nested/deck/*` },
      { ...route("partial"), pattern: `${ENV.PUBLISH_HOST}/partial*` },
      { ...route("wrong-worker"), script: "another-worker" },
      { ...route("suffix-worker"), script: `${ENV.WORKER_PREFIX}suffix-worker-other` },
      { pattern: `${ENV.PUBLISH_HOST}/no-script/*` },
      { ...route("null-script"), script: null },
      ...["gateway", "index", "assets", "Bad", "-bad", "bad-", "a".repeat(47)].map(route),
    ];
    const api = fakeFetch(() =>
      Response.json({ success: true, result: [...accepted, ...rejected] }),
    );

    const response = await handleRequest(request(), ENV, memoryCache(), api.fetcher, NOW);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect([...html.matchAll(/href="(\/[a-z0-9-]+\/)"/g)].map((match) => match[1])).toEqual([
      "/a-talk/",
      "/secure/",
      "/z-talk/",
    ]);
    expect(html).not.toContain("slides.altmejd.se");
  });

  test("uses the configured zone and token without following API redirects", async () => {
    const api = fakeFetch(() => routesResponse(["talk"]));
    await handleRequest(request(), ENV, memoryCache(), api.fetcher, NOW);

    expect(api.calls).toHaveLength(1);
    const call = api.calls[0];
    expect(call.url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ENV.CLOUDFLARE_ZONE_ID}/workers/routes`,
    );
    expect(call.method).toBe("GET");
    expect(call.headers.get("authorization")).toBe(`Bearer ${ENV.CLOUDFLARE_API_TOKEN}`);
    expect(call.redirect).toBe("manual");
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  test("escapes a configured title and serves HEAD without a body", async () => {
    const env = { ...ENV, INDEX_TITLE: 'Talks <script>alert("x")</script> & research' };
    const cache = memoryCache();
    const api = fakeFetch(() => routesResponse(["talk"]));
    const get = await handleRequest(request(), env, cache, api.fetcher, NOW);
    const html = await get.text();
    expect(html).toContain("Talks &lt;script&gt;");
    expect(html).toContain("&amp; research");
    expect(html).not.toContain("<script>alert");

    const head = await handleRequest(request("/", "HEAD"), env, cache, api.fetcher, NOW);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
    expect(api.calls).toHaveLength(1);
  });

  test("rejects missing or invalid root configuration before calling the API", async () => {
    const api = fakeFetch(() => routesResponse(["talk"]));
    for (const override of [
      { PUBLISH_HOST: "" },
      { PUBLISH_HOST: "https://talks.example.org" },
      { CLOUDFLARE_ZONE_ID: "" },
      { CLOUDFLARE_ZONE_ID: "../another-zone" },
      { CLOUDFLARE_API_TOKEN: "" },
      { WORKER_PREFIX: "" },
    ]) {
      const response = await handleRequest(
        request(),
        { ...ENV, ...override },
        memoryCache(),
        api.fetcher,
        NOW,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(ENV.CLOUDFLARE_API_TOKEN);
    }
    expect(api.calls).toHaveLength(0);
  });

  test("handles host, path, and method routing without a route lookup", async () => {
    const api = fakeFetch(() => routesResponse(["talk"]));
    const cache = memoryCache();
    const wrongHost = await handleRequest(
      new Request("https://other.example.org/"),
      ENV,
      cache,
      api.fetcher,
      NOW,
    );
    expect(wrongHost.status).toBe(404);
    const redirect = await handleRequest(request("/talk?print-pdf"), ENV, cache, api.fetcher, NOW);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`https://${ENV.PUBLISH_HOST}/talk/?print-pdf`);
    const unknown = await handleRequest(request("/talk/missing"), ENV, cache, api.fetcher, NOW);
    expect(unknown.status).toBe(404);
    const post = await handleRequest(request("/", "POST"), ENV, cache, api.fetcher, NOW);
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(api.calls).toHaveLength(0);
  });

  test("preserves fallback redirects and 404s when index credentials are missing", async () => {
    const env = { ...ENV, CLOUDFLARE_API_TOKEN: "" };
    const api = fakeFetch(() => routesResponse(["talk"]));
    const cache = memoryCache();
    const redirect = await handleRequest(request("/talk"), env, cache, api.fetcher, NOW);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`https://${ENV.PUBLISH_HOST}/talk/`);
    const missing = await handleRequest(request("/talk/missing"), env, cache, api.fetcher, NOW);
    expect(missing.status).toBe(404);
    const root = await handleRequest(request(), env, cache, api.fetcher, NOW);
    expect(root.status).toBe(503);
    expect(api.calls).toHaveLength(0);
  });

  test("reuses a fresh snapshot across root queries and HEAD requests", async () => {
    const api = fakeFetch(() => routesResponse(["talk"]));
    const cache = memoryCache();
    await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    const cached = await handleRequest(
      request("/?utm_source=bookmark"),
      ENV,
      cache,
      api.fetcher,
      NOW + MINUTE,
    );
    const head = await handleRequest(
      request("/", "HEAD"),
      ENV,
      cache,
      api.fetcher,
      NOW + 4 * MINUTE,
    );
    expect(cached.status).toBe(200);
    expect(await cached.text()).toContain('href="/talk/"');
    expect(head.status).toBe(200);
    expect(api.calls).toHaveLength(1);
    expect(cache.writes).toBe(1);
  });

  test("refreshes after five minutes and removes unpublished decks", async () => {
    let slugs = ["old", "retained"];
    const api = fakeFetch(() => routesResponse(slugs));
    const cache = memoryCache();
    await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    slugs = ["new", "retained"];
    const refreshed = await handleRequest(request(), ENV, cache, api.fetcher, NOW + 5 * MINUTE + 1);
    const html = await refreshed.text();
    expect(html).toContain('href="/new/"');
    expect(html).toContain('href="/retained/"');
    expect(html).not.toContain('href="/old/"');
    expect(api.calls).toHaveLength(2);
    expect(cache.writes).toBe(2);
  });

  test("serves the last snapshot with a visible notice when refresh fails", async () => {
    let failing = false;
    const api = fakeFetch(() => {
      if (failing) throw new Error("network unavailable");
      return routesResponse(["saved"]);
    });
    const cache = memoryCache();
    await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    failing = true;
    const stale = await handleRequest(request(), ENV, cache, api.fetcher, NOW + 6 * MINUTE);
    expect(stale.status).toBe(200);
    const html = await stale.text();
    expect(html).toContain('href="/saved/"');
    expect(html).toContain("Showing the last available list");
    expect(cache.writes).toBe(1);
  });

  test("fails visibly without a usable snapshot when the API is unavailable or malformed", async () => {
    for (const failure of [
      () => new Response("unavailable", { status: 503 }),
      () =>
        new Response(null, { status: 302, headers: { location: "https://other.example.org/" } }),
      () => Response.json({ success: false, result: [] }),
      () => Response.json({ result: [] }),
      () => Response.json({ success: true, result: {} }),
      () => Response.json({ success: true, result: [{ pattern: "bad/*", script: {} }] }),
      () => new Response("not JSON"),
      () => {
        throw new Error("network unavailable");
      },
    ]) {
      const api = fakeFetch(failure);
      const cache = memoryCache();
      const response = await handleRequest(request(), ENV, cache, api.fetcher, NOW);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("temporarily unavailable");
      expect(cache.writes).toBe(0);
    }
  });

  test("expires a snapshot after 24 hours even when the API fails", async () => {
    const cache = memoryCache(JSON.stringify({ slugs: ["expired"], fetchedAt: NOW }));
    const api = fakeFetch(() => new Response("unavailable", { status: 503 }));
    const response = await handleRequest(
      request(),
      ENV,
      cache,
      api.fetcher,
      NOW + 24 * 60 * MINUTE + 1,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('href="/expired/"');
    expect(cache.writes).toBe(0);
  });

  test("renders an empty state only after a successful empty route response", async () => {
    const api = fakeFetch(() => routesResponse([]));
    const cache = memoryCache();
    const response = await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No slides are published here yet");
    expect(cache.writes).toBe(1);
  });

  test("ignores malformed or unsafe cached snapshots", async () => {
    const api = fakeFetch(() => new Response("unavailable", { status: 503 }));
    for (const snapshot of [
      "not JSON",
      JSON.stringify({ slugs: "talk", fetchedAt: NOW }),
      JSON.stringify({ slugs: ["<script>"], fetchedAt: NOW }),
      JSON.stringify({ slugs: ["talk"], fetchedAt: "today" }),
    ]) {
      const response = await handleRequest(request(), ENV, memoryCache(snapshot), api.fetcher, NOW);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("<script>");
    }
  });

  test("rejects an oversized API response without replacing the last successful snapshot", async () => {
    let oversized = false;
    const api = fakeFetch(() => {
      if (!oversized) return routesResponse(["saved"]);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(2 * 1024 * 1024 + 1)));
            controller.close();
          },
        }),
      );
    });
    const cache = memoryCache();
    await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    oversized = true;
    const response = await handleRequest(request(), ENV, cache, api.fetcher, NOW + 6 * MINUTE);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/saved/"');
    expect(cache.writes).toBe(1);
  });

  test("does not poison a successful snapshot with a malformed API refresh", async () => {
    let malformed = false;
    const api = fakeFetch(() =>
      malformed ? Response.json({ success: true, result: null }) : routesResponse(["saved"]),
    );
    const cache = memoryCache();
    await handleRequest(request(), ENV, cache, api.fetcher, NOW);
    malformed = true;
    const response = await handleRequest(request(), ENV, cache, api.fetcher, NOW + 6 * MINUTE);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('href="/saved/"');
    expect(cache.writes).toBe(1);
  });

  test("isolates cached listings when the configured host, zone, or Worker prefix changes", async () => {
    for (const override of [
      { PUBLISH_HOST: "slides.example.net" },
      { CLOUDFLARE_ZONE_ID: "fedcba9876543210fedcba9876543210" },
      { WORKER_PREFIX: "another-slides-" },
    ]) {
      const cache = memoryCache();
      const original = fakeFetch(() => routesResponse(["original"]));
      await handleRequest(request(), ENV, cache, original.fetcher, NOW);
      const env = { ...ENV, ...override };
      const api = fakeFetch(() =>
        Response.json({
          success: true,
          result: [
            { pattern: `${env.PUBLISH_HOST}/different/*`, script: `${env.WORKER_PREFIX}different` },
          ],
        }),
      );
      const response = await handleRequest(
        new Request(`https://${env.PUBLISH_HOST}/`),
        env,
        cache,
        api.fetcher,
        NOW + MINUTE,
      );
      const html = await response.text();
      expect(api.calls).toHaveLength(1);
      expect(html).toContain('href="/different/"');
      expect(html).not.toContain('href="/original/"');
    }
  });
});
