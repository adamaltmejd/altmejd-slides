import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [htmlPath, selector, noAgendaPath, showcasePath, numberedAgendaPath, plainAgendaPath] =
  process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;

if (
  !htmlPath ||
  !selector ||
  !noAgendaPath ||
  !showcasePath ||
  !numberedAgendaPath ||
  !plainAgendaPath
) {
  throw new Error(
    "usage: check_reveal_fixture.mjs HTML SELECTOR NO_AGENDA_HTML SHOWCASE_HTML NUMBERED_AGENDA_HTML PLAIN_AGENDA_HTML",
  );
}
if (!existsSync(htmlPath)) {
  throw new Error(`rendered deck does not exist: ${htmlPath}`);
}
if (!existsSync(noAgendaPath)) {
  throw new Error(`rendered no-agenda deck does not exist: ${noAgendaPath}`);
}
if (!existsSync(showcasePath)) {
  throw new Error(`rendered showcase deck does not exist: ${showcasePath}`);
}
if (!existsSync(numberedAgendaPath) || !existsSync(plainAgendaPath)) {
  throw new Error("rendered agenda-variant decks do not exist");
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
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => globalThis.Reveal?.isReady());
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  const deckUrl = pathToFileURL(htmlPath);
  await openReadyDeck(page, deckUrl.href);

  const indices = await page.$eval(selector, (element) => {
    const slide = element.closest("section");
    if (!slide) {
      throw new Error("target selector is not inside a Reveal slide");
    }
    return globalThis.Reveal.getIndices(slide);
  });
  await page.evaluate(({ h, v }) => globalThis.Reveal.slide(h, v), indices);
  await page.waitForFunction(
    (targetSelector) => document.querySelector(targetSelector)?.clientHeight > 0,
    {},
    selector,
  );

  const result = await page.evaluate((targetSelector) => {
    const element = document.querySelector(targetSelector);
    if (!element) {
      throw new Error(`selector not found: ${targetSelector}`);
    }
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      agendaSlides: document.querySelectorAll(".slides section.agenda-slide").length,
      clientHeight: element.clientHeight,
      overflowing: element.scrollHeight > element.clientHeight + 2,
      primary: rootStyle.getPropertyValue("--altmejd-primary").trim().toLowerCase(),
      scrollHeight: element.scrollHeight,
      slideRemoteLoaded: typeof globalThis.SlideRemote === "function",
    };
  }, selector);

  console.log(JSON.stringify({ selector, ...result }));
  if (result.overflowing) {
    throw new Error(`vertical overflow detected for ${selector}`);
  }
  if (result.agendaSlides !== 1) {
    throw new Error(`expected one default agenda slide, found ${result.agendaSlides}`);
  }
  if (result.primary !== "#0057b8") {
    throw new Error(`YAML primary color was not applied: ${result.primary}`);
  }
  if (!result.slideRemoteLoaded) {
    throw new Error("embedded Slide Remote plugin was not loaded");
  }

  const layout = await page.evaluate(async () => {
    const show = async (id) => {
      const slide = document.getElementById(id);
      if (!slide) {
        throw new Error(`fixture slide is missing: ${id}`);
      }
      const { h, v } = globalThis.Reveal.getIndices(slide);
      globalThis.Reveal.slide(h, v);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return slide;
    };
    const rect = (element) => element.getBoundingClientRect();
    const footer = document.querySelector(".footer");

    const title = await show("title-slide");
    const authors = title.querySelector(".quarto-title-authors");
    const titleStyle = getComputedStyle(authors);
    const titleRect = rect(title);
    const titleScale = titleRect.width / title.offsetWidth;
    const titleRuleTop =
      titleRect.top + Number.parseFloat(getComputedStyle(title, "::before").top) * titleScale;
    const titleHeading = title.querySelector(".title");
    const titleHeadingRect = rect(titleHeading);
    const titleMetaRects = [title.querySelector(".subtitle"), title.querySelector(".date")]
      .filter(Boolean)
      .map(rect);
    const titleMetaBottom = Math.max(...titleMetaRects.map((item) => item.bottom));
    const titleFooterHidden = getComputedStyle(footer).display === "none";
    const authorRects = Array.from(authors.children, rect);
    const affiliationsInline = Array.from(authors.children).every((author) => {
      const affiliations = Array.from(author.querySelectorAll(".quarto-title-affiliation"));
      return (
        affiliations.every((affiliation) => getComputedStyle(affiliation).display === "inline") &&
        affiliations.slice(0, -1).every((affiliation) => {
          const separator = getComputedStyle(affiliation, "::after");
          return (
            separator.content === '","' &&
            Number.parseFloat(separator.marginLeft) < 0 &&
            Number.parseFloat(separator.marginRight) === 0
          );
        })
      );
    });

    const agenda = await show(document.querySelector(".agenda-slide").id);
    const agendaHeading = agenda.querySelector(".agenda-heading");
    const kicker = agenda.querySelector(".section-kicker");
    const agendaList = agenda.querySelector(".agenda");
    const agendaOrder = rect(kicker).bottom <= rect(agendaList).top + 1;
    const agendaIsPlain =
      agendaHeading === null && agendaList.querySelector(":scope > ul, :scope > ol") === null;
    const agendaFooterHidden = getComputedStyle(footer).display === "none";
    const agendaItems = Array.from(agendaList.children);
    const agendaItemStyles = agendaItems.map((item) => getComputedStyle(item));
    const agendaTypography =
      new Set(agendaItemStyles.map((style) => style.fontWeight)).size === 1 &&
      agendaItemStyles.every((style) => style.opacity === "1") &&
      Number.parseFloat(getComputedStyle(agendaList).rowGap) > 5;

    const directJumpSlide = await show("notes-and-aside");
    const contentHeading = directJumpSlide.querySelector(":scope > h2");
    const contentRuleTop =
      rect(contentHeading).bottom -
      Number.parseFloat(getComputedStyle(contentHeading, "::after").height) * titleScale;
    const directJumpImage = directJumpSlide.querySelector(":scope > img");
    if (!directJumpImage.complete || directJumpImage.naturalWidth === 0) {
      await new Promise((resolve) => {
        directJumpImage.addEventListener("load", resolve, { once: true });
        directJumpImage.addEventListener("error", resolve, { once: true });
      });
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const directJumpImageRect = rect(directJumpImage);

    const panelSlide = await show("automatic-figure-panels");
    await Promise.all(
      Array.from(panelSlide.querySelectorAll("img")).map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => image.addEventListener("load", resolve, { once: true })),
      ),
    );
    const panels = panelSlide.querySelector(".figure-panels");
    const panelHeadings = Array.from(panels.children, (panel) => panel.firstElementChild);
    const panelImages = Array.from(panels.querySelectorAll("img"));
    const panelNav = panelSlide.querySelector(".slide-nav");

    const onePanelSlide = await show("explicit-one-panel-layout");
    const onePanel = onePanelSlide.querySelector(".figure-panels");

    const mathSlide = await show("self-contained-mathematics");
    const mathElements = Array.from(mathSlide.querySelectorAll(".katex"));
    const mathNavDock = mathSlide.querySelector(".slide-nav");
    const mathNav = mathSlide.querySelector(".slide-nav a");
    const mathNavDockRect = rect(mathNavDock);
    const mathSlideRect = rect(mathSlide);
    const mathNavDockStyle = getComputedStyle(mathNavDock);
    const mathNavStyle = getComputedStyle(mathNav);
    const mathNavGroup = mathNavDock.querySelector(":scope > p") ?? mathNavDock;
    const mathNavRect = rect(mathNav);
    const mathSizes = mathElements.map((math) => ({
      display: getComputedStyle(math).display,
      height: rect(math).height,
      width: rect(math).width,
    }));

    // Shown before compact-navigation on purpose: both live in the same
    // vertical stack, only the stack's active child keeps a layout, and the
    // lazily-built navRows rects below need compact-navigation to stay the
    // active stack child until the return object is constructed.
    const darkSlide = await show("dark-background-navigation");
    const darkChip = darkSlide.querySelector(".slide-nav a");
    const darkChipColor = getComputedStyle(darkChip).color;
    const darkChipBackground = getComputedStyle(darkChip).backgroundColor;
    const darkSlideColor = getComputedStyle(darkSlide).color;

    const navSlide = await show("compact-navigation");
    const navLinks = Array.from(navSlide.querySelectorAll(".slide-nav a"));
    const navFigure = navSlide.querySelector(":scope > img");
    const navSlideRect = rect(navSlide);
    const navFigureRect = rect(navFigure);
    navLinks[1].focus();
    const focusedStyle = getComputedStyle(navLinks[1]);

    const asideSlide = await show("notes-and-aside");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const aside = asideSlide.querySelector(":scope > .aside, :scope > aside:not(.notes)");
    const asideNavigation = asideSlide.querySelector(":scope > .slide-nav");
    const asideNavigationLinks = Array.from(asideNavigation.querySelectorAll("a"));
    const backLink = asideNavigationLinks[0];
    const stretched = asideSlide.querySelector(":scope > .r-stretch");
    const asideSlideRect = rect(asideSlide);
    const stretchedRect = rect(stretched);

    return {
      mainFontSize: Number.parseFloat(getComputedStyle(document.querySelector(".reveal")).fontSize),
      agendaFooterHidden,
      agendaIsPlain,
      agendaOrder,
      agendaTypography,
      directJumpMediaVisible:
        directJumpImage.naturalWidth > 0 &&
        directJumpImageRect.width > 100 &&
        directJumpImageRect.height > 100,
      // Raw geometry for cross-platform debugging: Edge on Windows has
      // rendered this stretch image collapsed while other images were fine.
      directJumpDebug: {
        complete: directJumpImage.complete,
        natural: [directJumpImage.naturalWidth, directJumpImage.naturalHeight],
        rect: [Math.round(directJumpImageRect.width), Math.round(directJumpImageRect.height)],
        inline: directJumpImage.getAttribute("style") || "",
        classes: directJumpImage.className,
        src: (directJumpImage.getAttribute("src") || "").split("/").pop(),
        currentSrc: (directJumpImage.currentSrc || "").split("/").pop(),
        slideStyle: asideSlide.getAttribute("style") || "",
        slideClasses: asideSlide.className,
        slideSize: [asideSlide.offsetWidth, asideSlide.offsetHeight],
        scale: globalThis.Reveal.getScale(),
        watchdog: globalThis.__altmejdDiag ?? null,
      },
      asideReserved:
        asideSlide.classList.contains("has-altmejd-aside") &&
        asideSlide.classList.contains("has-altmejd-navigation") &&
        getComputedStyle(asideSlide).getPropertyValue("--altmejd-aside-height").trim() !== "" &&
        getComputedStyle(asideSlide).getPropertyValue("--altmejd-navigation-height").trim() !==
          "" &&
        rect(stretched).bottom <= rect(aside).top + 1 &&
        rect(aside).bottom <= rect(asideNavigation).top + 1 &&
        Math.abs(rect(asideNavigation).bottom - rect(asideSlide).bottom) < 2 &&
        rect(stretched).width > 100 &&
        rect(stretched).height > 100,
      darkChipDistinct: darkChipColor !== darkSlideColor && darkChipColor !== darkChipBackground,
      backControl:
        backLink.classList.contains("back") &&
        !backLink.textContent.trim().toLowerCase().startsWith("back:") &&
        getComputedStyle(backLink, "::before").content.includes("←") &&
        backLink.getAttribute("aria-label")?.startsWith("Back to ") &&
        getComputedStyle(backLink).backgroundColor ===
          getComputedStyle(asideNavigationLinks[1]).backgroundColor &&
        getComputedStyle(backLink).color === getComputedStyle(asideNavigationLinks[1]).color,
      standaloneFigureCentered:
        Math.abs(
          stretchedRect.left +
            stretchedRect.width / 2 -
            (asideSlideRect.left + asideSlideRect.width / 2),
        ) < 2,
      figureAlignmentOverride:
        navFigure.classList.contains("quarto-figure-left") &&
        Math.abs(navFigureRect.left - navSlideRect.left) < 2,
      focusVisible:
        focusedStyle.outlineStyle !== "none" && Number.parseFloat(focusedStyle.outlineWidth) >= 2,
      navDisplay: getComputedStyle(navLinks[0]).display,
      navRows: new Set(navLinks.map((link) => Math.round(rect(link).top))).size,
      panelDisplay: getComputedStyle(panels).display,
      panelHeadingsAligned:
        Math.max(...panelHeadings.map((heading) => rect(heading).top)) -
          Math.min(...panelHeadings.map((heading) => rect(heading).top)) <
        2,
      panelImagesVisible: panelImages.every(
        (image) => rect(image).width > 100 && rect(image).height > 100,
      ),
      panelNavReserved:
        Math.max(...panelImages.map((image) => rect(image).bottom)) <= rect(panelNav).top + 1,
      panelSlideEnriched:
        panelSlide.classList.contains("layout-fill") && panels.classList.contains("figure-panels"),
      onePanelSupported:
        onePanelSlide.classList.contains("layout-fill") &&
        onePanel.children.length === 1 &&
        rect(onePanel.firstElementChild).width > onePanelSlide.clientWidth * 0.8,
      bundledKatex:
        mathElements.length >= 2 &&
        mathSizes.every((math) => math.width > 0 && math.height > 0) &&
        globalThis.katex?.version === "0.18.4",
      mathCount: mathElements.length,
      mathNavDocked:
        Math.abs(mathNavDockRect.right - mathSlideRect.right) < 2 &&
        Math.abs(mathNavDockRect.bottom - mathSlideRect.bottom) < 2 &&
        mathNavDockRect.width < mathSlideRect.width / 2,
      mathNavDockUnboxed:
        mathNavDockStyle.backgroundColor === "rgba(0, 0, 0, 0)" &&
        Number.parseFloat(mathNavDockStyle.borderTopWidth) === 0 &&
        Number.parseFloat(mathNavDockStyle.paddingLeft) === 0,
      mathNavDockRightDifference: Math.abs(mathNavDockRect.right - mathSlideRect.right),
      mathNavDockWidth: mathNavDockRect.width,
      mathSlideWidth: mathSlideRect.width,
      mathNavGap: Number.parseFloat(getComputedStyle(mathNav).columnGap),
      mathNavGroupGap: Number.parseFloat(getComputedStyle(mathNavGroup).columnGap),
      mathNavHeight: mathNavRect.height,
      mathNavPadding: Number.parseFloat(getComputedStyle(mathNav).paddingLeft),
      mathNavRadius: Number.parseFloat(mathNavStyle.borderRadius),
      mathSizes,
      titleColumns: titleStyle.gridTemplateColumns.split(" ").filter(Boolean).length,
      titleAffiliationsInline: affiliationsInline,
      titleAuthorsCompact: rect(authors).width < titleRect.width * 0.85,
      titleAuthorsOneRow: new Set(authorRects.map((author) => Math.round(author.top))).size === 1,
      titleAuthorsSeparated: titleHeadingRect.bottom + 40 < rect(authors).top,
      titleAuthorRule: Number.parseFloat(getComputedStyle(authors).borderTopWidth) === 1,
      titleFits: title.scrollHeight <= title.clientHeight + 2,
      titleFooterHidden,
      titleHeadingSize: Number.parseFloat(getComputedStyle(titleHeading).fontSize),
      titleMetaAligned:
        titleMetaRects.length < 2 ||
        Math.max(...titleMetaRects.map((item) => item.bottom)) -
          Math.min(...titleMetaRects.map((item) => item.bottom)) <
          1,
      titleMetaBeforeHeading: titleMetaBottom + 8 < titleHeadingRect.top,
      titleRuleThicknessDifference: Math.abs(
        Number.parseFloat(getComputedStyle(title, "::before").height) -
          Number.parseFloat(getComputedStyle(contentHeading, "::after").height),
      ),
      titleRuleDifference: Math.abs(titleRuleTop - contentRuleTop),
    };
  });
  console.log(JSON.stringify({ layout }));
  // The threshold assertions below are one-directional, so a probe that
  // returns NaN (for example after a theme rule is removed) must fail loudly
  // instead of slipping through as a vacuously false comparison.
  const numericProbes = [
    "mainFontSize",
    "mathNavGap",
    "mathNavGroupGap",
    "mathNavHeight",
    "mathNavPadding",
    "mathNavRadius",
    "titleHeadingSize",
    "titleRuleDifference",
    "titleRuleThicknessDifference",
  ];
  const nonFiniteProbes = numericProbes.filter((key) => !Number.isFinite(layout[key]));
  if (nonFiniteProbes.length > 0) {
    throw new Error(`layout probes are not finite numbers: ${nonFiniteProbes.join(", ")}`);
  }
  if (
    layout.mainFontSize !== 40 ||
    layout.titleColumns !== 4 ||
    !layout.titleAffiliationsInline ||
    !layout.titleAuthorsCompact ||
    !layout.titleAuthorsOneRow ||
    !layout.titleAuthorsSeparated ||
    !layout.titleAuthorRule ||
    !layout.titleFits ||
    !layout.titleFooterHidden ||
    layout.titleHeadingSize < 75 ||
    !layout.titleMetaAligned ||
    !layout.titleMetaBeforeHeading ||
    layout.titleRuleThicknessDifference > 0.1 ||
    layout.titleRuleDifference > 0.5
  ) {
    throw new Error(`multi-author title layout failed: ${JSON.stringify(layout)}`);
  }
  if (
    !layout.agendaIsPlain ||
    !layout.agendaOrder ||
    !layout.agendaFooterHidden ||
    !layout.agendaTypography
  ) {
    throw new Error(`default agenda layout failed: ${JSON.stringify(layout)}`);
  }
  if (
    !layout.panelSlideEnriched ||
    !layout.directJumpMediaVisible ||
    layout.panelDisplay !== "grid" ||
    !layout.panelHeadingsAligned ||
    !layout.panelImagesVisible ||
    !layout.panelNavReserved ||
    !layout.onePanelSupported ||
    !layout.bundledKatex ||
    !layout.mathNavDocked ||
    !layout.mathNavDockUnboxed ||
    layout.mathNavGap <= 0 ||
    layout.mathNavGroupGap < 4 ||
    layout.mathNavHeight <= 18 ||
    layout.mathNavHeight >= 32 ||
    layout.mathNavPadding < 8 ||
    layout.mathNavRadius <= 3 ||
    layout.mathNavRadius >= 20 ||
    !layout.standaloneFigureCentered ||
    !layout.figureAlignmentOverride
  ) {
    throw new Error(`figure panel layout failed: ${JSON.stringify(layout)}`);
  }
  if (
    !["flex", "inline-flex"].includes(layout.navDisplay) ||
    layout.navRows < 2 ||
    !layout.focusVisible ||
    !layout.asideReserved ||
    !layout.backControl ||
    !layout.darkChipDistinct
  ) {
    throw new Error(`navigation or live aside contract failed: ${JSON.stringify(layout)}`);
  }

  // Standalone figures run in their own evaluate call with eager captures, so
  // navigating between these slides cannot stale the probes above.
  const figures = await page.evaluate(async () => {
    const rect = (element) => element.getBoundingClientRect();
    const show = async (id) => {
      const slide = document.getElementById(id);
      if (!slide) {
        throw new Error(`fixture slide is missing: ${id}`);
      }
      const { h, v } = globalThis.Reveal.getIndices(slide);
      globalThis.Reveal.slide(h, v);
      const images = Array.from(slide.querySelectorAll("img"), (image) =>
        image.complete && image.naturalWidth > 0
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            }),
      );
      await Promise.all(images);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return slide;
    };
    const centered = (element, slide) =>
      Math.abs(
        rect(element).left + rect(element).width / 2 - (rect(slide).left + rect(slide).width / 2),
      ) < 2;
    const asideOf = (slide) => slide.querySelector(":scope > .aside, :scope > aside:not(.notes)");

    // Quarto drops auto-stretch on any slide holding an aside, so an untagged
    // lone figure must still be stretched and centered by the format itself.
    const implicitSlide = await show("implicit-figure-stretch");
    const implicitFigure = implicitSlide.querySelector(":scope > img");
    const implicitStretched =
      implicitFigure.classList.contains("r-stretch") &&
      rect(implicitFigure).width > rect(implicitSlide).width * 0.6 &&
      rect(implicitFigure).height > 100 &&
      centered(implicitFigure, implicitSlide) &&
      rect(implicitFigure).bottom <= rect(asideOf(implicitSlide)).top + 1;

    // A captioned figure keeps Quarto's `<figure>` wrapper, so it fills the
    // slide by layout: the image contains itself above its own caption line
    // and the whole object clears the aside.
    const captionedSlide = await show("captioned-figure-stretch");
    const captionedFigure = captionedSlide.querySelector("img");
    const caption = captionedSlide.querySelector("figcaption");
    const captionedFits =
      captionedSlide.classList.contains("layout-fill") &&
      rect(captionedFigure).width > rect(captionedSlide).width * 0.6 &&
      rect(captionedFigure).height > 100 &&
      rect(captionedFigure).right <= rect(captionedSlide).right + 2 &&
      centered(captionedFigure, captionedSlide) &&
      rect(captionedFigure).bottom <= rect(caption).top + 1 &&
      rect(caption).bottom <= rect(asideOf(captionedSlide)).top + 1;

    // A lone figure wrapped in an internal link is a clickable figure, not a
    // navigation row, so it must stay in flow at full size.
    const linkedSlide = await show("linked-figure");
    const linkedFigure = linkedSlide.querySelector("img");
    const linkedInFlow =
      linkedSlide.querySelector(".slide-nav") === null &&
      rect(linkedFigure).width > 100 &&
      rect(linkedFigure).height > 100 &&
      centered(linkedFigure, linkedSlide) &&
      rect(linkedFigure).bottom <= rect(asideOf(linkedSlide)).top + 1;

    return { implicitStretched, captionedFits, linkedInFlow };
  });
  console.log(JSON.stringify({ figures }));
  if (!figures.implicitStretched || !figures.captionedFits || !figures.linkedInFlow) {
    throw new Error(`standalone figure layout failed: ${JSON.stringify(figures)}`);
  }

  // The v0.4 primitives run in their own evaluate call with eager captures,
  // because these slides share the configured section's vertical stack and
  // only the active stack child keeps a layout.
  const primitives = await page.evaluate(async () => {
    const show = async (id) => {
      const slide = document.getElementById(id);
      if (!slide) {
        throw new Error(`fixture slide is missing: ${id}`);
      }
      const { h, v } = globalThis.Reveal.getIndices(slide);
      globalThis.Reveal.slide(h, v);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return slide;
    };
    const rect = (element) => element.getBoundingClientRect();
    const footer = document.querySelector(".footer");
    const slideNumber = document.querySelector(".slide-number");

    const statement = await show("statement-stress");
    const statementParagraph = statement.querySelector(":scope > p");
    const statementStats = Array.from(statement.querySelectorAll(".stat-row > p"));
    const statementProbe = {
      centered: getComputedStyle(statement).justifyContent === "center",
      fits: statement.scrollHeight <= statement.clientHeight + 2,
      kickerRuleGone: getComputedStyle(statement.querySelector("h2"), "::after").content === "none",
      sentenceSize: Number.parseFloat(getComputedStyle(statementParagraph).fontSize),
      statColumns:
        statementStats.length === 3 &&
        statementStats.every((stat) => getComputedStyle(stat).flexDirection === "column"),
      statSize: Number.parseFloat(
        getComputedStyle(statement.querySelector(".stat-row .stat")).fontSize,
      ),
    };

    const calloutSlide = await show("callout-family");
    const callouts = Array.from(calloutSlide.querySelectorAll(".callout"));
    const calloutProbe = {
      count: callouts.length,
      distinctInks:
        new Set(callouts.map((callout) => getComputedStyle(callout).borderLeftColor)).size ===
        callouts.length,
      iconsHidden: callouts.every(
        (callout) =>
          getComputedStyle(callout.querySelector(".callout-icon-container")).display === "none",
      ),
      ruleWidths: callouts.map((callout) =>
        Number.parseFloat(getComputedStyle(callout).borderLeftWidth),
      ),
      titlesQuiet: callouts.every((callout) => {
        const title = callout.querySelector(".callout-title");
        const paragraph = title.querySelector("p");
        return (
          getComputedStyle(title).backgroundColor === "rgba(0, 0, 0, 0)" &&
          getComputedStyle(paragraph).textTransform === "uppercase" &&
          getComputedStyle(paragraph).color === getComputedStyle(callout).borderLeftColor
        );
      }),
    };

    const darkSlide = await show("dark-background-navigation");
    const darkCallout = darkSlide.querySelector(".callout");
    const darkPrimaryChip = darkSlide.querySelector(".slide-nav a.primary");
    const darkCalloutProbe = {
      solidSurface: getComputedStyle(darkCallout).backgroundColor === "rgb(241, 245, 249)",
      darkText:
        getComputedStyle(darkCallout.querySelector(".callout-content p")).color ===
        "rgb(15, 23, 42)",
      primaryChipLight: getComputedStyle(darkPrimaryChip).color === "rgb(248, 250, 252)",
    };

    const skipped = await show("skipped-section");
    const skippedHeading = skipped.querySelector("h1");
    const skippedProbe = {
      notAgenda: !skipped.classList.contains("agenda-slide"),
      headingVisible: skippedHeading.getBoundingClientRect().width > 100,
    };

    const buildUp = await show("figure-build-up");
    const layers = Array.from(buildUp.querySelectorAll(".r-stack img"));
    await Promise.all(
      layers.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => image.addEventListener("load", resolve, { once: true })),
      ),
    );
    const layerCenters = layers.map((image) => {
      const box = rect(image);
      return [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
    });
    const buildUpProbe = {
      layerCount: layers.length,
      layersAligned:
        Math.abs(layerCenters[0][0] - layerCenters[1][0]) <= 2 &&
        Math.abs(layerCenters[0][1] - layerCenters[1][1]) <= 2,
      secondIsFragment: layers[1].classList.contains("fragment"),
    };

    const gating = await show("mode-gating");
    const gatingProbe = {
      liveVisible: getComputedStyle(gating.querySelector(".live-only")).display !== "none",
      handoutHidden: getComputedStyle(gating.querySelector(".handout-only")).display === "none",
    };

    const photograph = await show("photograph");
    const photographHeading = photograph.querySelector("h2");
    const photographCaption = photograph.querySelector(":scope > p");
    const photographAttribution = photograph.querySelector(":scope > .attribution");
    const photographProbe = {
      attributionHorizontal:
        getComputedStyle(photographAttribution).writingMode === "horizontal-tb",
      captionCapped: rect(photographCaption).width < rect(photograph).width * 0.75,
      chromeHidden:
        getComputedStyle(footer).display === "none" &&
        getComputedStyle(slideNumber).display === "none",
      headingBottom: rect(photographHeading).bottom > rect(photograph).height * 0.5,
      scrimmed: getComputedStyle(photographHeading).backgroundColor.includes("0.66"),
    };

    const closing = await show("closing");
    const closingContact = closing.querySelector(":scope > p:first-of-type");
    const closingQr = closing.querySelector("img.qr");
    const closingProbe = {
      contactRuled: Number.parseFloat(getComputedStyle(closingContact).borderTopWidth) === 1,
      fits: closing.scrollHeight <= closing.clientHeight + 2,
      footerHidden: getComputedStyle(footer).display === "none",
      qrDocked:
        getComputedStyle(closingQr).position === "absolute" &&
        Math.abs(rect(closingQr).right - rect(closing).right) < 2,
      qrGenerated:
        closingQr.src.startsWith("data:image/svg+xml;base64,") &&
        closingQr.alt.includes("example.org"),
      ruleHeight: Number.parseFloat(getComputedStyle(closing, "::before").height),
      headingRuleGone: getComputedStyle(closing.querySelector("h2"), "::after").content === "none",
    };

    return {
      buildUp: buildUpProbe,
      callouts: calloutProbe,
      closing: closingProbe,
      darkCallout: darkCalloutProbe,
      gating: gatingProbe,
      photograph: photographProbe,
      skipped: skippedProbe,
      statement: statementProbe,
    };
  });
  console.log(JSON.stringify({ primitives }));
  if (
    !primitives.statement.centered ||
    !primitives.statement.fits ||
    !primitives.statement.kickerRuleGone ||
    !Number.isFinite(primitives.statement.sentenceSize) ||
    primitives.statement.sentenceSize < 55 ||
    !primitives.statement.statColumns ||
    !Number.isFinite(primitives.statement.statSize) ||
    primitives.statement.statSize < 70
  ) {
    throw new Error(`statement contract failed: ${JSON.stringify(primitives.statement)}`);
  }
  if (
    primitives.callouts.count !== 3 ||
    !primitives.callouts.distinctInks ||
    !primitives.callouts.iconsHidden ||
    !primitives.callouts.ruleWidths.every((width) => width === 4) ||
    !primitives.callouts.titlesQuiet ||
    !primitives.darkCallout.solidSurface ||
    !primitives.darkCallout.darkText ||
    !primitives.darkCallout.primaryChipLight
  ) {
    throw new Error(
      `callout contract failed: ${JSON.stringify({
        callouts: primitives.callouts,
        darkCallout: primitives.darkCallout,
      })}`,
    );
  }
  if (
    primitives.buildUp.layerCount !== 2 ||
    !primitives.buildUp.layersAligned ||
    !primitives.buildUp.secondIsFragment
  ) {
    throw new Error(`figure build-up contract failed: ${JSON.stringify(primitives.buildUp)}`);
  }
  if (!primitives.gating.liveVisible || !primitives.gating.handoutHidden) {
    throw new Error(`live mode gating failed: ${JSON.stringify(primitives.gating)}`);
  }
  if (!primitives.skipped.notAgenda || !primitives.skipped.headingVisible) {
    throw new Error(`no-agenda section contract failed: ${JSON.stringify(primitives.skipped)}`);
  }
  if (
    !primitives.photograph.attributionHorizontal ||
    !primitives.photograph.captionCapped ||
    !primitives.photograph.chromeHidden ||
    !primitives.photograph.headingBottom ||
    !primitives.photograph.scrimmed
  ) {
    throw new Error(`full-bleed contract failed: ${JSON.stringify(primitives.photograph)}`);
  }
  if (
    !primitives.closing.contactRuled ||
    !primitives.closing.fits ||
    !primitives.closing.footerHidden ||
    !primitives.closing.qrDocked ||
    !primitives.closing.qrGenerated ||
    primitives.closing.ruleHeight !== 4 ||
    !primitives.closing.headingRuleGone
  ) {
    throw new Error(`closing slide contract failed: ${JSON.stringify(primitives.closing)}`);
  }

  deckUrl.search = "?handout=true";
  await openReadyDeck(page, deckUrl.href);
  const handout = await page.evaluate(async () => {
    const slide = document.getElementById("notes-and-aside");
    const { h, v } = globalThis.Reveal.getIndices(slide);
    globalThis.Reveal.slide(h, v);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const notes = document.querySelector(".slides aside.notes");
    const aside = slide.querySelector(":scope > .aside, :scope > aside:not(.notes)");
    const navigation = slide.querySelector(":scope > .slide-nav");
    const stretched = slide.querySelector(":scope > .r-stretch");
    const noteRect = notes.getBoundingClientRect();
    const asideRect = aside.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    const gating = document.getElementById("mode-gating");
    return {
      active: document.documentElement.classList.contains("altmejd-handout"),
      notesVisible: notes !== null && getComputedStyle(notes).display !== "none",
      boxesStacked:
        stretched.getBoundingClientRect().bottom <= asideRect.top + 1 &&
        asideRect.bottom <= noteRect.top + 1 &&
        noteRect.bottom <= navigationRect.top + 1 &&
        Math.abs(navigationRect.bottom - slide.getBoundingClientRect().bottom) < 2,
      liveHidden: getComputedStyle(gating.querySelector(".live-only")).display === "none",
      handoutShown: getComputedStyle(gating.querySelector(".handout-only")).display !== "none",
    };
  });
  console.log(JSON.stringify({ handout }));
  if (
    !handout.active ||
    !handout.notesVisible ||
    !handout.boxesStacked ||
    !handout.liveHidden ||
    !handout.handoutShown
  ) {
    throw new Error(`handout mode contract failed: ${JSON.stringify(handout)}`);
  }

  await openReadyDeck(page, pathToFileURL(noAgendaPath).href);
  const disabledAgendaSlides = await page.$$eval(
    ".slides section.agenda-slide",
    (elements) => elements.length,
  );
  if (disabledAgendaSlides !== 0) {
    throw new Error(`agenda.enabled=false produced ${disabledAgendaSlides} agenda slides`);
  }
  const singleAuthorTitle = await page.evaluate(() => {
    const slide = document.getElementById("title-slide");
    const title = slide.querySelector(".title").getBoundingClientRect();
    const authors = slide.querySelector(".quarto-title-authors");
    const authorRect = authors.getBoundingClientRect();
    return {
      authorCount: authors.children.length,
      authorRule: Number.parseFloat(getComputedStyle(authors).borderTopWidth) === 1,
      separated: title.bottom + 40 < authorRect.top,
      fits: slide.scrollHeight <= slide.clientHeight + 2,
    };
  });
  if (
    singleAuthorTitle.authorCount !== 1 ||
    !singleAuthorTitle.authorRule ||
    !singleAuthorTitle.separated ||
    !singleAuthorTitle.fits
  ) {
    throw new Error(`single-author title layout failed: ${JSON.stringify(singleAuthorTitle)}`);
  }

  await openReadyDeck(page, pathToFileURL(numberedAgendaPath).href);
  const numberedAgenda = await page.evaluate(() => ({
    agendas: document.querySelectorAll(".agenda-bullets-numbered").length,
    orderedLists: document.querySelectorAll(".agenda-bullets-numbered > ol").length,
    kicker: Boolean(document.querySelector(".agenda-slide .section-kicker")),
    // The fixture enables agenda.clickable, so every item links to its
    // section without picking up the prose underline.
    links: document.querySelectorAll('.agenda a[href^="#"]').length,
    linksQuiet: Array.from(document.querySelectorAll(".agenda a")).every(
      (link) => getComputedStyle(link).textDecorationLine === "none",
    ),
  }));
  if (
    numberedAgenda.agendas !== 2 ||
    numberedAgenda.orderedLists !== 2 ||
    !numberedAgenda.kicker ||
    numberedAgenda.links !== 4 ||
    !numberedAgenda.linksQuiet
  ) {
    throw new Error(`numbered agenda variant failed: ${JSON.stringify(numberedAgenda)}`);
  }

  await openReadyDeck(page, pathToFileURL(plainAgendaPath).href);
  const plainAgenda = await page.evaluate(() => ({
    agendas: document.querySelectorAll(".agenda-bullets-none").length,
    headings: document.querySelectorAll(".agenda-slide .agenda-heading").length,
    lists: document.querySelectorAll(".agenda-bullets-none > ul, .agenda-bullets-none > ol").length,
    kicker: Boolean(document.querySelector(".agenda-slide .section-kicker")),
    typography: (() => {
      const agenda = document.querySelector(".agenda-bullets-none");
      const items = Array.from(agenda.children);
      const styles = items.map((item) => getComputedStyle(item));
      return (
        styles.length > 1 &&
        new Set(styles.map((style) => style.fontWeight)).size === 1 &&
        styles.every((style) => style.opacity === "1") &&
        styles[0].color !== styles[1].color &&
        Number.parseFloat(getComputedStyle(agenda).rowGap) > 5
      );
    })(),
  }));
  if (
    plainAgenda.agendas !== 11 ||
    plainAgenda.headings !== 0 ||
    plainAgenda.lists !== 0 ||
    !plainAgenda.kicker ||
    !plainAgenda.typography
  ) {
    throw new Error(`unbulleted agenda variant failed: ${JSON.stringify(plainAgenda)}`);
  }

  await openReadyDeck(page, pathToFileURL(showcasePath).href);
  const showcaseTitle = await page.evaluate(() => {
    const slide = document.getElementById("title-slide");
    const title = slide.querySelector(".title").getBoundingClientRect();
    const authors = slide.querySelector(".quarto-title-authors");
    const authorRect = authors.getBoundingClientRect();
    return {
      authorCount: authors.children.length,
      authorRule: Number.parseFloat(getComputedStyle(authors).borderTopWidth) === 1,
      separated: title.bottom + 40 < authorRect.top,
      fits: slide.scrollHeight <= slide.clientHeight + 2,
    };
  });
  if (
    showcaseTitle.authorCount !== 4 ||
    !showcaseTitle.authorRule ||
    !showcaseTitle.separated ||
    !showcaseTitle.fits
  ) {
    throw new Error(`showcase title layout failed: ${JSON.stringify(showcaseTitle)}`);
  }
  const publicWorkerUrl = await page.$eval(
    'meta[name="slide-remote-worker-url"]',
    (element) => element.content,
  );
  if (publicWorkerUrl !== "") {
    throw new Error("public showcase must not configure a Slide Remote Worker URL");
  }
} finally {
  await browser.close();
}
