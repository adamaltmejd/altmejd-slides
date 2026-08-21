import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [htmlPath] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;

if (!htmlPath) {
  throw new Error("usage: check_showcase.mjs SHOWCASE_HTML");
}
if (!existsSync(htmlPath)) {
  throw new Error(`rendered showcase does not exist: ${htmlPath}`);
}
if (!chromePath || !existsSync(chromePath)) {
  throw new Error("CHROME_PATH must point to a Chrome or Chromium executable");
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--allow-file-access-from-files"],
});

async function openReadyDeck(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => globalThis.Reveal?.isReady());
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function auditShowcase(page, url, mode) {
  await openReadyDeck(page, url);
  return page.evaluate(async ({ handout, narrow }) => {
    const visible = (element) => {
      if (!element) {
        return false;
      }
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const rect = (element) => element.getBoundingClientRect();
    const intersects = (left, right) =>
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
    const waitForImage = async (image) => {
      if (image.complete && image.naturalWidth > 0) {
        return;
      }
      await Promise.race([
        new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    };
    const waitForSlide = async (slide) => {
      const { h, v } = globalThis.Reveal.getIndices(slide);
      globalThis.Reveal.slide(h, v);
      if (handout) {
        while (globalThis.Reveal.nextFragment()) {
          // The PDF contract is one final-state page per slide.
        }
      }
      await Promise.all(Array.from(slide.querySelectorAll("img"), waitForImage));
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };

    const slides = globalThis.Reveal.getSlides();
    const overflow = [];
    const collisions = [];
    const agendaFailures = [];
    const panelFailures = [];
    const noteFailures = [];

    for (const slide of slides) {
      await waitForSlide(slide);
      const slideRect = rect(slide);

      if (
        slide.scrollWidth > slide.clientWidth + 2 ||
        slide.scrollHeight > slide.clientHeight + 2
      ) {
        overflow.push(slide.id || "(untitled)");
      }

      for (const child of Array.from(slide.children)) {
        if (!visible(child) || child.matches("aside.notes")) {
          continue;
        }
        const childRect = rect(child);
        if (
          childRect.left < slideRect.left - 2 ||
          childRect.right > slideRect.right + 2 ||
          childRect.top < slideRect.top - 2 ||
          childRect.bottom > slideRect.bottom + 2
        ) {
          overflow.push(`${slide.id || "(untitled)"}:${child.tagName.toLowerCase()}`);
        }
      }

      const aside = Array.from(slide.children).find(
        (child) => child.matches(".aside, aside:not(.notes)") && visible(child),
      );
      const note = Array.from(slide.children).find((child) => child.matches("aside.notes"));
      const navigation = Array.from(slide.children).find(
        (child) => child.matches(".slide-nav") && visible(child),
      );
      const visibleNote = handout && visible(note) ? note : undefined;
      const bottomBoxes = [aside, visibleNote, navigation].filter(Boolean);

      for (let index = 1; index < bottomBoxes.length; index += 1) {
        if (rect(bottomBoxes[index - 1]).bottom > rect(bottomBoxes[index]).top + 1) {
          collisions.push(slide.id || "(untitled)");
        }
      }

      if (bottomBoxes.length > 0) {
        const boundaryTop = rect(bottomBoxes[0]).top;
        const contentBottom = Math.max(
          ...Array.from(slide.children)
            .filter(
              (child) =>
                visible(child) &&
                !bottomBoxes.includes(child) &&
                !child.matches("aside.notes, .attribution, h1, h2"),
            )
            .map((child) => rect(child).bottom),
          Number.NEGATIVE_INFINITY,
        );
        if (contentBottom > boundaryTop + 1) {
          collisions.push(slide.id || "(untitled)");
        }
      }

      if (note && visible(note) !== handout) {
        noteFailures.push(slide.id || "(untitled)");
      }

      // Flowing content must stay clear of the spine attribution's painted
      // text. The element box stretches the full slide height so its line can
      // center, so the probe uses the text's client rects, not the box;
      // full-bleed slides restyle the attribution as a corner chip instead.
      const attribution = Array.from(slide.children).find(
        (child) => child.matches(".attribution") && visible(child),
      );
      if (attribution && !slide.classList.contains("full-bleed")) {
        const textRange = document.createRange();
        // Select inside the paragraph: its block box also stretches the full
        // slide height, and only the glyph fragments mark real ink.
        textRange.selectNodeContents(attribution.querySelector("p") ?? attribution);
        const attributionRects = Array.from(textRange.getClientRects());
        for (const child of Array.from(slide.children)) {
          if (
            child === attribution ||
            !visible(child) ||
            getComputedStyle(child).position === "absolute"
          ) {
            continue;
          }
          const childRect = rect(child);
          if (attributionRects.some((textRect) => intersects(childRect, textRect))) {
            collisions.push(`${slide.id || "(untitled)"}:attribution`);
          }
        }
      }

      if (slide.classList.contains("agenda-slide")) {
        const agenda = slide.querySelector(":scope > .agenda");
        const kicker = slide.querySelector(":scope > .section-kicker");
        const items = agenda ? Array.from(agenda.children) : [];
        const weights = new Set(items.map((item) => getComputedStyle(item).fontWeight));
        const footer = document.querySelector(".footer");
        if (
          !agenda ||
          !kicker ||
          rect(kicker).bottom > rect(agenda).top + 1 ||
          items.length !== 5 ||
          items.filter((item) => item.classList.contains("agenda-active")).length !== 1 ||
          weights.size !== 1 ||
          getComputedStyle(footer).display !== "none"
        ) {
          agendaFailures.push(slide.id || "(untitled)");
        }
      }

      const panels = slide.querySelector(":scope > .figure-panels");
      if (panels) {
        const panelRects = Array.from(panels.children, rect);
        const panelImages = Array.from(panels.querySelectorAll("img"));
        const overlapping = panelRects.some((left, leftIndex) =>
          panelRects.some((right, rightIndex) => leftIndex < rightIndex && intersects(left, right)),
        );
        const desktopWidthsDiffer =
          !narrow &&
          panelRects.length === 2 &&
          Math.abs(panelRects[0].width - panelRects[1].width) > 2;
        if (
          overlapping ||
          desktopWidthsDiffer ||
          panelImages.some(
            (image) =>
              image.naturalWidth === 0 || rect(image).width < 40 || rect(image).height < 40,
          )
        ) {
          panelFailures.push(slide.id || "(untitled)");
        }
      }

      if (handout) {
        const hiddenFragments = Array.from(slide.querySelectorAll(".fragment")).filter(
          (fragment) => !fragment.classList.contains("visible"),
        );
        if (hiddenFragments.length > 0) {
          noteFailures.push(`${slide.id || "(untitled)"}:fragments`);
        }
      }
    }

    const slideIds = slides.map((slide) => slide.id).filter(Boolean);
    const duplicateIds = slideIds.filter((id, index) => slideIds.indexOf(id) !== index);
    const internalLinks = Array.from(document.querySelectorAll('.slides a[href^="#"]'));
    const brokenLinks = internalLinks
      .map((link) => link.getAttribute("href"))
      .filter((href) => {
        const target = decodeURIComponent(href.replace(/^#\/?/, "").split("?")[0]);
        return target && !document.getElementById(target);
      });
    const images = Array.from(document.querySelectorAll(".slides img"));
    const brokenImages = images.filter(
      (image) => image.naturalWidth === 0 || image.naturalHeight === 0,
    );
    const missingAlt = images.filter((image) => !image.getAttribute("alt")?.trim());

    const title = document.getElementById("title-slide");
    await waitForSlide(title);
    const authors = Array.from(title.querySelector(".quarto-title-authors").children);
    const authorRects = authors.map(rect);
    const authorOverlap = authorRects.some((left, leftIndex) =>
      authorRects.some((right, rightIndex) => leftIndex < rightIndex && intersects(left, right)),
    );

    const longNavigation = document.querySelector("#appendix-alternative .slide-nav");
    const navigationLinks = Array.from(longNavigation.querySelectorAll("a"));
    const navigationRows = new Set(navigationLinks.map((link) => Math.round(rect(link).top))).size;

    const math = Array.from(document.querySelectorAll(".slides .katex"));
    const remoteResources = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => /^https?:/i.test(name));

    return {
      // check() is true only for loaded faces; both families are used on
      // every deck (body text and the slide number), so by the end of the
      // sweep the bundled fonts must have resolved.
      bundledFonts:
        document.fonts.check('740 16px "Schibsted Grotesk"') &&
        document.fonts.check('400 16px "JetBrains Mono"'),
      agendaFailures,
      agendas: document.querySelectorAll(".slides section.agenda-slide").length,
      authorCount: authors.length,
      authorOverlap,
      brokenImages: brokenImages.length,
      brokenLinks,
      collisions: [...new Set(collisions)],
      duplicateIds: [...new Set(duplicateIds)],
      footnotes: document.querySelectorAll(".aside-footnotes").length,
      handoutActive: document.documentElement.classList.contains("altmejd-handout"),
      images: images.length,
      internalLinks: internalLinks.length,
      math: math.length,
      missingAlt: missingAlt.length,
      navigationRows,
      noteFailures: [...new Set(noteFailures)],
      notes: document.querySelectorAll(".slides aside.notes").length,
      overflow: [...new Set(overflow)],
      panelFailures,
      remoteResources,
      slideRemoteLoaded:
        globalThis.Reveal.hasPlugin("slide-remote") &&
        document.querySelector('meta[name="slide-remote-worker-url"]')?.content === "",
      slides: slides.length,
      scrollView: globalThis.Reveal.isScrollView(),
      scrollActivationWidth: globalThis.Reveal.getConfig().scrollActivationWidth,
      titleFits: title.scrollHeight <= title.clientHeight + 2,
    };
  }, mode);
}

function assertAudit(name, audit, expectedHandout) {
  const failures = {
    bundledFonts: !audit.bundledFonts,
    agendaFailures: audit.agendaFailures,
    authorOverlap: audit.authorOverlap,
    brokenImages: audit.brokenImages,
    brokenLinks: audit.brokenLinks,
    collisions: audit.collisions,
    duplicateIds: audit.duplicateIds,
    handoutActive: audit.handoutActive !== expectedHandout,
    missingAlt: audit.missingAlt,
    noteFailures: audit.noteFailures,
    overflow: audit.overflow,
    panelFailures: audit.panelFailures,
    remoteResources: audit.remoteResources,
    slideRemoteLoaded: !audit.slideRemoteLoaded,
    scrollView: audit.scrollView,
    titleFits: !audit.titleFits,
    wrongFeatureCounts:
      audit.slides !== 35 ||
      audit.agendas !== 5 ||
      audit.authorCount !== 4 ||
      audit.images < 16 ||
      audit.internalLinks < 22 ||
      audit.notes < 8 ||
      audit.footnotes !== 1 ||
      audit.math < 10 ||
      audit.navigationRows < 1,
  };
  const activeFailures = Object.fromEntries(
    Object.entries(failures).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value),
    ),
  );
  console.log(JSON.stringify({ name, audit }));
  if (Object.keys(activeFailures).length > 0) {
    throw new Error(`${name} showcase audit failed: ${JSON.stringify(activeFailures)}`);
  }
}

try {
  const browserProblems = [];
  const newAuditPage = async (viewport) => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => browserProblems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      // Puppeteer's CDP transport reports console.warn as "warn"; "warning"
      // is kept in case another transport still uses the legacy name.
      if (["error", "warning", "warn"].includes(message.type())) {
        browserProblems.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (request.url().startsWith("file:")) {
        browserProblems.push(`requestfailed: ${request.url()}`);
      }
    });
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    return page;
  };

  const deckUrl = pathToFileURL(htmlPath);
  const desktopPage = await newAuditPage({ width: 1600, height: 900 });
  const desktop = await auditShowcase(desktopPage, deckUrl.href, {
    handout: false,
    narrow: false,
  });
  assertAudit("desktop-live", desktop, false);
  await desktopPage.close();

  const narrowPage = await newAuditPage({ width: 390, height: 844 });
  const narrow = await auditShowcase(narrowPage, deckUrl.href, {
    handout: false,
    narrow: true,
  });
  assertAudit("narrow-live", narrow, false);
  await narrowPage.close();

  deckUrl.search = "?pdf=handout&handout=true&pdfSeparateFragments=false";
  const handoutPage = await newAuditPage({ width: 1600, height: 900 });
  const handout = await auditShowcase(handoutPage, deckUrl.href, {
    handout: true,
    narrow: false,
  });
  assertAudit("desktop-handout", handout, true);
  await handoutPage.close();

  if (browserProblems.length > 0) {
    throw new Error(`browser problems: ${JSON.stringify(browserProblems)}`);
  }
} finally {
  await browser.close();
}
