import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [fixturePath, showcasePath] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;
if (![fixturePath, showcasePath, chromePath].every((path) => path && existsSync(path))) {
  throw new Error(
    "usage: CHROME_PATH=... node tools/check_accessibility.mjs AUTHORING_HTML SHOWCASE_HTML",
  );
}
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        window.initialHistoryLength = history.length;
      },
      { once: true },
    );
  });
  const open = async (path, params = {}, hash = "") => {
    const url = pathToFileURL(path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.hash = hash;
    await page.goto(url.href, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.altmejdReaderReady === "true" ||
        globalThis.Reveal?.isReady(),
    );
    if (params.reading)
      await page.waitForFunction(
        () => document.documentElement.dataset.altmejdReaderReady === "true",
      );
  };
  const show = async (id) => {
    await page.evaluate((target) => {
      const { h, v } = globalThis.Reveal.getIndices(document.getElementById(target));
      globalThis.Reveal.slide(h, v);
    }, id);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
    );
  };

  await page.setViewport({ width: 1280, height: 720 });
  await open(fixturePath);
  await show("merged-navigation");
  const targets = await page.$$eval("#merged-navigation .slide-nav a", (links) =>
    links
      .filter((link) => link.getClientRects().length)
      .map((link) => ({
        height: link.getBoundingClientRect().height,
        font: Number.parseFloat(getComputedStyle(link).fontSize) * globalThis.Reveal.getScale(),
      })),
  );
  assert.ok(
    targets.every((target) => target.height >= 31.9 && target.font >= 13.9),
    JSON.stringify(targets),
  );
  await page.focus("#merged-navigation .slide-nav a");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    const focusedSlide = await page.evaluate(
      () => document.activeElement.closest(".slides section")?.id,
    );
    assert.ok(
      !focusedSlide || focusedSlide === "merged-navigation",
      `Tab entered hidden slide ${focusedSlide}`,
    );
  }
  await page.keyboard.down("Shift");
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    const focusedSlide = await page.evaluate(
      () => document.activeElement.closest(".slides section")?.id,
    );
    assert.ok(
      !focusedSlide || focusedSlide === "merged-navigation",
      `Shift+Tab entered ${focusedSlide}`,
    );
  }
  await page.keyboard.up("Shift");
  await page.focus("#merged-navigation .slide-nav a");
  await page.keyboard.press("Enter");
  assert.equal(
    await page.evaluate(() => globalThis.Reveal.getCurrentSlide().id),
    "fixed-image-aside",
  );
  await page.evaluate(() => globalThis.Reveal.toggleOverview(true));
  assert.equal(await page.$$eval(".slides section[inert]", (slides) => slides.length), 0);
  await page.evaluate(() => globalThis.Reveal.toggleOverview(false));
  assert.equal(
    await page.$eval(".slide-menu-button a", (link) => link.getAttribute("aria-label")),
    "Open slide menu",
  );

  await show("dark-components");
  const contrast = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const luminance = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const rgb = Array.from(context.getImageData(0, 0, 1, 1).data)
        .slice(0, 3)
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return [".stat", "blockquote a", "blockquote strong", ".emph", ".table-note"].map(
      (selector) => {
        const element = document.querySelector(`#dark-components ${selector}`);
        const surface = element.closest("blockquote") || element.closest("section");
        const a = luminance(getComputedStyle(element).color);
        const b = luminance(
          surface.dataset.backgroundColor || getComputedStyle(surface).backgroundColor,
        );
        return { selector, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      },
    );
  });
  for (const item of contrast)
    assert.ok(item.ratio >= (item.selector === ".stat" ? 3 : 4.5), JSON.stringify(item));

  const menuContrast = await page.evaluate(async () => {
    const results = [];
    for (const [selector, background, dark] of [
      [".slide-menu-button i", "#0f172a", true],
      [".slide-menu-toolbar .fa-images", "#f8fafc", false],
    ]) {
      const style = getComputedStyle(document.querySelector(selector), "::before");
      const icon = new Image();
      icon.src = JSON.parse(style.backgroundImage.slice(4, -1));
      await icon.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext("2d");
      context.fillStyle = background;
      context.fillRect(0, 0, 32, 32);
      const luminance = (rgb) =>
        rgb
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const base = luminance(Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3));
      context.filter = style.filter;
      context.drawImage(icon, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      let ink = base;
      for (let index = 0; index < pixels.length; index += 4) {
        const value = luminance(Array.from(pixels.slice(index, index + 3)));
        ink = dark ? Math.max(ink, value) : Math.min(ink, value);
      }
      results.push((Math.max(ink, base) + 0.05) / (Math.min(ink, base) + 0.05));
    }
    return results;
  });
  assert.ok(
    menuContrast.every((ratio) => ratio >= 3),
    JSON.stringify(menuContrast),
  );
  assert.ok(
    await page.$eval(".slide-menu-wrapper", (menu) =>
      Array.from(menu.querySelectorAll("a")).some(
        (link) => link.textContent === "Read slides" && link.href.includes("reading=true"),
      ),
    ),
  );

  await page.setViewport({ width: 375, height: 812 });
  await show("merged-navigation");
  const mobile = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll(".altmejd-mobile-nav a"));
    return {
      heights: links.map((a) => a.getBoundingClientRect().height),
      readHeight: document.querySelector(".altmejd-read-link").getBoundingClientRect().height,
      names: links.map((a) => a.textContent.trim()),
      originalHidden:
        getComputedStyle(document.querySelector("#merged-navigation .slide-nav")).display ===
        "none",
    };
  });
  assert.ok(mobile.heights.every((height) => height >= 44));
  assert.ok(mobile.readHeight >= 44);
  assert.equal(mobile.originalHidden, true);
  assert.deepEqual(mobile.names, ["Data", "Methods", "Back", "Live discussion"]);
  await page.click(".altmejd-mobile-nav a");
  assert.equal(
    await page.evaluate(() => globalThis.Reveal.getCurrentSlide().id),
    "fixed-image-aside",
  );
  await open(showcasePath);
  await show("robustness-summary");
  assert.equal(
    await page.$eval(".reveal .footer", (footer) => getComputedStyle(footer).display),
    "none",
  );

  for (const handout of [false, true]) {
    await open(
      fixturePath,
      { reading: "true", ...(handout ? { handout: "true" } : {}) },
      "#/gated-asides",
    );
    const reading = await page.evaluate(() => ({
      main: document.querySelectorAll("main.altmejd-reader").length,
      canvas: document.querySelectorAll(".reveal").length,
      font: getComputedStyle(document.querySelector("main")).fontSize,
      gatedAsideIds: Array.from(
        document.querySelectorAll("#gated-asides .altmejd-aside"),
        (aside) => aside.id,
      ),
      privateNote: document.querySelector("#gated-speaker-note aside.notes")?.textContent,
      hash: location.hash,
      brokenAnchors: Array.from(document.querySelectorAll('.altmejd-reader a[href^="#/"]')).length,
      back: document.querySelector(".altmejd-reader-toolbar a").hash,
      inert: document.querySelectorAll("main [inert]").length,
      decorativeHidden: document.getElementById("decorative-mark").getAttribute("aria-hidden"),
      canvasAlpha: document.getElementById("sample-chart").getContext("2d").getImageData(0, 0, 1, 1)
        .data[3],
      backgroundFrame: document.querySelector("#background-document iframe")?.getAttribute("src"),
    }));
    assert.equal(reading.main, 1);
    assert.equal(reading.canvas, 0);
    assert.equal(reading.font, "18px");
    assert.deepEqual(reading.gatedAsideIds, [handout ? "handout-aside" : "live-aside"]);
    assert.equal(reading.privateNote, undefined);
    assert.equal(reading.hash, "#gated-asides");
    assert.equal(reading.back, "#/gated-asides");
    assert.equal(reading.brokenAnchors, 0);
    assert.equal(reading.inert, 0);
    assert.equal(reading.decorativeHidden, "true");
    assert.equal(reading.canvasAlpha, 255);
    assert.ok(reading.backgroundFrame.endsWith("estimate.svg"));
  }
  await open(showcasePath, { reading: "true", handout: "true" });
  const readerShowcase = await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.querySelectorAll("img"), (image) => image.decode().catch(() => {})),
    );
    return {
      slides: document.querySelectorAll("main > section").length,
      authorColumns: getComputedStyle(
        document.querySelector(".quarto-title-authors"),
      ).gridTemplateColumns.split(" ").length,
      authorFont: getComputedStyle(document.querySelector(".quarto-title-author-name")).fontSize,
      listIndent: Number.parseFloat(
        getComputedStyle(document.querySelector("main ul")).paddingLeft,
      ),
      overflow: document.documentElement.scrollWidth > innerWidth + 2,
      notes: document.querySelectorAll("main aside.notes").length,
      fragments: document.querySelectorAll("main .fragment").length,
      stackImages: Array.from(
        document.querySelectorAll("main .r-stack"),
        (stack) => stack.children.length,
      ),
      loaded: Array.from(document.querySelectorAll("main img"), (image) => image.naturalWidth > 0),
      mathAccessible:
        Boolean(document.querySelector(".katex-mathml")) &&
        document.querySelector(".katex-html").getAttribute("aria-hidden") === "true",
    };
  });
  assert.equal(readerShowcase.slides, 36);
  assert.equal(readerShowcase.authorColumns, 1);
  assert.equal(readerShowcase.authorFont, "16px");
  assert.ok(readerShowcase.listIndent >= 24);
  assert.equal(readerShowcase.overflow, false);
  assert.ok(readerShowcase.notes > 0);
  assert.equal(readerShowcase.fragments, 0);
  assert.ok(readerShowcase.stackImages.every((count) => count === 1));
  assert.ok(readerShowcase.loaded.every(Boolean));
  assert.equal(readerShowcase.mathAccessible, true);

  const chromeSizes = [];
  for (const width of [1600, 3200]) {
    await page.setViewport({ width, height: (width * 9) / 16 });
    await open(showcasePath, { pdf: "true" });
    await show("robustness-summary");
    chromeSizes.push(
      await page.evaluate(() =>
        [".footer", ".slide-number"].map((selector) =>
          Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
        ),
      ),
    );
  }
  for (let index = 0; index < 2; index++)
    assert.ok(
      Math.abs(chromeSizes[1][index] / chromeSizes[0][index] - 2) < 0.01,
      JSON.stringify(chromeSizes),
    );

  await page.setViewport({ width: 1600, height: 900 });
  await open(fixturePath, { check: "true" }, "#/fixed-image-aside");
  await page.waitForFunction(() => globalThis.altmejdSlideReport, { timeout: 30000 });
  const preflight = await page.evaluate(() => ({
    ...globalThis.altmejdSlideReport,
    current: globalThis.Reveal.getCurrentSlide().id,
    transition: globalThis.Reveal.getConfig().transition,
    dialogOpen: document.querySelector("dialog").open,
    historyGrowth: history.length - window.initialHistoryLength,
  }));
  const deliberate = preflight.issues.filter((issue) => issue.id === "preflight-errors");
  for (const phrase of ["no alt", "could not be loaded", "clipped", "Broken internal link"])
    assert.ok(
      deliberate.some((issue) => issue.message.includes(phrase)),
      JSON.stringify(preflight),
    );
  assert.equal(preflight.current, "fixed-image-aside");
  assert.equal(preflight.transition, "none");
  assert.equal(preflight.dialogOpen, true);
  assert.ok(preflight.historyGrowth <= 1, JSON.stringify(preflight));
  await page.click("dialog button");
  assert.equal(await page.$eval("dialog", (dialog) => dialog.open), false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      name: "accessibility-and-reading",
      targets,
      contrast,
      menuContrast,
      mobile,
      readerShowcase,
      chromeSizes,
      preflightIssues: preflight.issues.length,
    }),
  );
} finally {
  await browser.close();
}
