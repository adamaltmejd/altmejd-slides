// Serves a staged publish tree (public/<slug>/...) over local HTTP and checks
// that the deck actually works beneath its path prefix: the title slide loads,
// every stylesheet, script, font, and image resolves, Reveal hash navigation
// works, and the Slide Remote plugin still initializes without errors.
//
// usage: CHROME_PATH=... node tools/check_published_prefix.mjs PUBLIC_DIR SLUG

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import puppeteer from "puppeteer-core";

const [publicDir, slug] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;

if (!publicDir || !slug) {
  throw new Error("usage: check_published_prefix.mjs PUBLIC_DIR SLUG");
}
if (!existsSync(join(publicDir, slug, "index.html"))) {
  throw new Error(`staged deck does not exist: ${join(publicDir, slug, "index.html")}`);
}
if (!chromePath || !existsSync(chromePath)) {
  throw new Error("CHROME_PATH must point to a Chrome or Chromium executable");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".map": "application/json",
};

// Mirrors Cloudflare's auto-trailing-slash handling closely enough for the
// fixture: /slug redirects to /slug/, directories serve their index.html.
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  if (relative.startsWith("..")) {
    response.writeHead(400).end();
    return;
  }
  let filePath = join(publicDir, relative);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    if (!pathname.endsWith("/")) {
      response.writeHead(307, { location: `${pathname}/` }).end();
      return;
    }
    filePath = join(filePath, "index.html");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
  });
  response.end(readFileSync(filePath));
});

await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location()?.url?.endsWith("/favicon.ico")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText})`);
  });
  page.on("response", (response) => {
    // Browsers probe /favicon.ico on their own; decks do not ship one.
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      failedRequests.push(`${response.url()} (HTTP ${response.status()})`);
    }
  });

  // The bare prefix must redirect to the canonical trailing-slash URL.
  const bare = await page.goto(`${base}/${slug}`, { waitUntil: "networkidle0" });
  if (!bare.request().redirectChain().length) {
    throw new Error(`/${slug} did not redirect to /${slug}/`);
  }

  await page.goto(`${base}/${slug}/`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => globalThis.Reveal?.isReady());

  const title = await page.evaluate(
    () => document.querySelector(".reveal .slides section")?.textContent?.trim() ?? "",
  );
  if (title.length === 0) {
    throw new Error("title slide rendered empty");
  }

  // Hash navigation beneath the prefix.
  await page.evaluate(() => globalThis.Reveal.next());
  await page.waitForFunction(() => globalThis.location.hash.length > 1);
  const hash = await page.evaluate(() => globalThis.location.hash);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => globalThis.Reveal?.isReady());
  const restored = await page.evaluate(
    () => globalThis.Reveal.getIndices().h > 0 || globalThis.location.hash.length > 1,
  );
  if (!restored) {
    throw new Error(`hash navigation did not survive reload (hash was ${hash})`);
  }

  // Slide Remote must still register as a Reveal plugin when the deck bundles
  // it; a deck without a configured worker URL loads it and exits quietly.
  const slideRemote = await page.evaluate(() => {
    const plugins = globalThis.Reveal?.getPlugins?.() ?? {};
    return Object.keys(plugins).some((id) => id.toLowerCase().includes("remote"));
  });
  const bundlesRemote =
    existsSync(join(publicDir, slug)) &&
    readFileSync(join(publicDir, slug, "index.html"), "utf8").includes("slide-remote");
  if (bundlesRemote && !slideRemote) {
    throw new Error("deck bundles slide-remote but the plugin did not register");
  }

  if (failedRequests.length > 0) {
    throw new Error(`resources failed to load:\n  ${failedRequests.join("\n  ")}`);
  }
  if (consoleErrors.length > 0) {
    throw new Error(`browser console errors:\n  ${consoleErrors.join("\n  ")}`);
  }

  console.log(`prefix serving ok: /${slug}/ loads, navigates, and resolves every resource`);
} finally {
  await browser.close();
  server.close();
}
