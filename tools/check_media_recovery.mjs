// Regression: a lazy-loaded image whose request fails (flaky venue Wi-Fi)
// used to stay permanently blank — Reveal assigns `src` at reveal time and
// neither the browser nor Reveal retries a failed load. The runtime now
// re-requests broken images on the current slide with a short backoff. This
// check serves the showcase with the first SVG request per asset failing
// (HTTP 503, which browsers do not retry on their own) and requires the
// deep-linked figure slide to recover.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";

const [htmlPath] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;

if (!htmlPath) {
  throw new Error("usage: check_media_recovery.mjs SHOWCASE_HTML");
}
if (!existsSync(htmlPath)) {
  throw new Error(`rendered showcase does not exist: ${htmlPath}`);
}
if (!chromePath || !existsSync(chromePath)) {
  throw new Error("CHROME_PATH must point to a Chrome or Chromium executable");
}

const root = path.dirname(path.resolve(htmlPath));
const entry = path.basename(htmlPath);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const attempts = new Map();
const server = createServer(async (request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (urlPath.endsWith(".svg")) {
    const count = (attempts.get(urlPath) || 0) + 1;
    attempts.set(urlPath, count);
    if (count === 1) {
      response.writeHead(503);
      response.end();
      return;
    }
  }
  try {
    const data = await readFile(path.join(root, urlPath === "/" ? entry : urlPath));
    response.writeHead(200, {
      "content-type": types[path.extname(urlPath)] || "application/octet-stream",
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/${entry}#/descriptive-pattern`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(() => globalThis.Reveal?.isReady());

  const snapshot = () =>
    page.evaluate(() =>
      Array.from(globalThis.Reveal.getCurrentSlide().querySelectorAll("img")).map((img) => ({
        src: (img.getAttribute("src") || "").split("/").pop(),
        natural: img.naturalWidth,
        height: Math.round(img.getBoundingClientRect().height),
      })),
    );

  const initial = await snapshot();
  if (initial.length === 0) {
    throw new Error("deep-linked slide has no images; the check is vacuous");
  }

  let recovered = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (state.every((img) => img.natural > 0 && img.height > 50)) {
      recovered = state;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!recovered) {
    throw new Error(
      `image did not recover from a failed request: ${JSON.stringify(await snapshot())}`,
    );
  }
  console.log(
    JSON.stringify({ name: "media-recovery", initial, recovered, retried: attempts.size }),
  );
} finally {
  await browser.close();
  server.close();
}
