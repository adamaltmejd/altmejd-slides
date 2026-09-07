import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [htmlPath, appendixAgendaPath] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;
if (!htmlPath || !existsSync(htmlPath)) {
  throw new Error("usage: check_authoring.mjs AUTHORING_HTML [APPENDIX_AGENDA_HTML]");
}
if (!chromePath || !existsSync(chromePath)) {
  throw new Error("CHROME_PATH must point to a Chrome or Chromium executable");
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--allow-file-access-from-files"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  for (const handout of [false, true]) {
    const url = pathToFileURL(htmlPath);
    if (handout) url.searchParams.set("handout", "true");
    await page.goto(url.href, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => globalThis.Reveal?.isReady());

    const result = await page.evaluate(async () => {
      const show = async (id) => {
        const slide = document.getElementById(id);
        const { h, v } = globalThis.Reveal.getIndices(slide);
        globalThis.Reveal.slide(h, v);
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        return slide;
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const imageSize = async (id) => {
        const slide = await show(id);
        const image = slide.querySelector("img");
        const rect = image.getBoundingClientRect();
        return {
          width: rect.width / globalThis.Reveal.getScale(),
          height: rect.height / globalThis.Reveal.getScale(),
          stretched: image.matches(".r-stretch, .stretch"),
          layoutFill: slide.classList.contains("layout-fill"),
        };
      };
      const sizes = {};
      for (const id of [
        "fixed-image-aside",
        "fixed-height-aside",
        "fixed-slide-aside",
        "fixed-caption-aside",
      ]) {
        sizes[id] = await imageSize(id);
      }

      const navigationSlide = await show("merged-navigation");
      const links = Array.from(navigationSlide.querySelectorAll(".slide-nav a")).filter(
        (link) => link.getClientRects().length,
      );
      const linkRects = links.map((link) => link.getBoundingClientRect());
      const navigation = {
        docks: navigationSlide.querySelectorAll(":scope > .slide-nav").length,
        labels: links.map((link) => link.textContent.trim()),
        explicitIdPreserved: Boolean(navigationSlide.querySelector("#explicit-navigation")),
        overlap: linkRects.some((left, index) =>
          linkRects.slice(index + 1).some((right) => {
            const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
            const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
            return width > 1 && height > 1;
          }),
        ),
      };

      const gatedNavigation = await show("gated-navigation");
      const gatedNavigationImage = gatedNavigation.querySelector("img").getBoundingClientRect();
      const dock = gatedNavigation.querySelector(":scope > .slide-nav");
      const gatedNavLinks = Array.from(dock.querySelectorAll("a")).filter(
        (link) => link.getClientRects().length,
      );
      const gatedAsides = await show("gated-asides");
      const visibleAsides = Array.from(gatedAsides.querySelectorAll(".altmejd-aside")).filter(
        visible,
      );
      const asideImage = gatedAsides.querySelector("img").getBoundingClientRect();
      const asideClearsImage = visibleAsides.every(
        (aside) => asideImage.bottom <= aside.getBoundingClientRect().top + 1,
      );
      const gatedNotes = await show("gated-speaker-note");
      const note = gatedNotes.querySelector("aside.notes");
      const gating = {
        navImageHeight: gatedNavigationImage.height,
        navLinks: gatedNavLinks.length,
        visibleAsideIds: visibleAsides.map((aside) => aside.id),
        asideRole: visibleAsides[0]?.getAttribute("role"),
        asideImageHeight: asideImage.height,
        asideClearsImage,
        noteHidden: !visible(note),
        noteReserved: gatedNotes.classList.contains("has-handout-notes"),
        noteImageHeight: gatedNotes.querySelector("img").getBoundingClientRect().height,
      };

      const native = await show("native-columns");
      const nativeColumns = Array.from(native.querySelectorAll(".column"));
      const nativeWidthRatio = nativeColumns[0].offsetWidth / nativeColumns[1].offsetWidth;
      const automatic = await show("automatic-panels");
      const panels = {
        nativeUpgraded: Boolean(native.querySelector(".figure-panels")),
        nativeFill: native.classList.contains("layout-fill"),
        nativeWidthRatio,
        automaticUpgraded: Boolean(automatic.querySelector(".figure-panels")),
        automaticFill: automatic.classList.contains("layout-fill"),
      };

      const qrSlide = await show("linked-qr");
      const qrLink = qrSlide.querySelector("a.qr-link");
      const qrImage = qrLink.querySelector("img.qr");
      const imageRect = qrImage.getBoundingClientRect();
      const linkRect = qrLink.getBoundingClientRect();
      qrLink.focus();
      const qr = {
        href: qrLink.getAttribute("href"),
        alt: qrImage.alt,
        title: qrLink.title,
        id: qrLink.id,
        imageVisible: imageRect.width > 50 && imageRect.height > 50 && qrImage.naturalWidth > 0,
        linkCoversImage:
          linkRect.left <= imageRect.left + 1 &&
          linkRect.top <= imageRect.top + 1 &&
          linkRect.right >= imageRect.right - 1 &&
          linkRect.bottom >= imageRect.bottom - 1,
        focusVisible:
          document.activeElement === qrLink && getComputedStyle(qrLink).outlineStyle !== "none",
      };
      const internalQr = await show("internal-qr");
      const internalLink = internalQr.querySelector("a.qr-link");
      const internalPromoted = Boolean(internalQr.querySelector(".slide-nav"));
      internalLink.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      qr.internalNavigates = globalThis.Reveal.getCurrentSlide().id === "automatic-panels";
      qr.internalPromoted = internalPromoted;

      const agendas = Array.from(document.querySelectorAll("section.agenda-slide"));
      const agenda = {
        count: agendas.length,
        items: agendas.map((slide) =>
          Array.from(slide.querySelectorAll(".agenda-active, .agenda-inactive")).map((item) =>
            item.textContent.trim(),
          ),
        ),
        current: agendas.map((slide) => {
          const links = slide.querySelectorAll(".agenda [aria-current='location']");
          return {
            count: links.length,
            href: links[0]?.getAttribute("href"),
            expected: `#/${slide.id}`,
          };
        }),
        appendixUncounted:
          document.getElementById("backup-detail").dataset.visibility === "uncounted",
      };
      const disabled = document
        .querySelector("meta[name='slide-remote-disable-on-params']")
        .content.split(",");
      return { sizes, navigation, gating, panels, qr, agenda, disabled };
    });

    for (const [id, size] of Object.entries(result.sizes)) {
      assert.equal(size.stretched, false, `${id} unexpectedly stretches`);
      assert.equal(size.layoutFill, false, `${id} unexpectedly fills the slide`);
      const actual = id === "fixed-height-aside" ? size.height : size.width;
      const expected = id === "fixed-height-aside" ? 180 : 300;
      assert.ok(Math.abs(actual - expected) < 1, `${id}: expected ${expected}, got ${actual}`);
    }
    assert.equal(result.navigation.docks, 1);
    assert.equal(result.navigation.overlap, false);
    assert.equal(result.navigation.explicitIdPreserved, true);
    assert.deepEqual(result.navigation.labels, [
      "Data",
      "Methods",
      "Back",
      handout ? "Reading detail" : "Live discussion",
    ]);
    assert.ok(result.gating.navImageHeight > 100, "hidden navigation collapsed the figure");
    assert.equal(result.gating.navLinks, handout ? 1 : 0);
    assert.deepEqual(result.gating.visibleAsideIds, [handout ? "handout-aside" : "live-aside"]);
    assert.equal(result.gating.asideRole, "note");
    assert.ok(result.gating.asideImageHeight > 100);
    assert.equal(result.gating.asideClearsImage, true);
    assert.equal(result.gating.noteHidden, true);
    assert.equal(result.gating.noteReserved, false);
    assert.ok(result.gating.noteImageHeight > 100);
    assert.equal(result.panels.nativeUpgraded, false);
    assert.equal(result.panels.nativeFill, false);
    assert.ok(Math.abs(result.panels.nativeWidthRatio - 3 / 7) < 0.01);
    assert.equal(result.panels.automaticUpgraded, true);
    assert.equal(result.panels.automaticFill, true);
    assert.equal(result.qr.href, "https://example.org/paper");
    assert.equal(result.qr.alt, "QR code for the paper");
    assert.equal(result.qr.title, "Open the paper");
    assert.equal(result.qr.id, "paper-qr");
    assert.equal(result.qr.imageVisible, true);
    assert.equal(result.qr.linkCoversImage, true);
    assert.equal(result.qr.focusVisible, true);
    assert.equal(result.qr.internalNavigates, true);
    assert.equal(result.qr.internalPromoted, false);
    assert.equal(result.agenda.count, 2);
    assert.deepEqual(result.agenda.items, [
      ["Main section", "Second section"],
      ["Main section", "Second section"],
    ]);
    for (const current of result.agenda.current) {
      assert.equal(current.count, 1);
      assert.equal(current.href, current.expected);
    }
    assert.equal(result.agenda.appendixUncounted, true);
    assert.deepEqual(result.disabled, ["custom-preview", "reading", "check"]);
    console.log(JSON.stringify({ name: "authoring-composition", handout, ...result }));
  }

  if (appendixAgendaPath) {
    await page.goto(pathToFileURL(appendixAgendaPath).href, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => globalThis.Reveal?.isReady());
    const appendix = await page.$eval("#appendix", (slide) => ({
      generated: slide.classList.contains("agenda-slide"),
      current: slide.querySelector(".agenda [aria-current='location']")?.textContent.trim(),
    }));
    assert.deepEqual(appendix, { generated: true, current: "Appendix" });
    console.log(JSON.stringify({ name: "appendix-agenda-opt-in", ...appendix }));
  }
} finally {
  await browser.close();
}
