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
    !layout.backControl
  ) {
    throw new Error(`navigation or live aside contract failed: ${JSON.stringify(layout)}`);
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
    return {
      active: document.documentElement.classList.contains("altmejd-handout"),
      notesVisible: notes !== null && getComputedStyle(notes).display !== "none",
      boxesStacked:
        stretched.getBoundingClientRect().bottom <= asideRect.top + 1 &&
        asideRect.bottom <= noteRect.top + 1 &&
        noteRect.bottom <= navigationRect.top + 1 &&
        Math.abs(navigationRect.bottom - slide.getBoundingClientRect().bottom) < 2,
    };
  });
  console.log(JSON.stringify({ handout }));
  if (!handout.active || !handout.notesVisible || !handout.boxesStacked) {
    throw new Error(`handout mode did not stack speaker notes: ${JSON.stringify(handout)}`);
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
  }));
  if (numberedAgenda.agendas !== 2 || numberedAgenda.orderedLists !== 2 || !numberedAgenda.kicker) {
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
