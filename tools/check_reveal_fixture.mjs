import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const [htmlPath, selector, noAgendaPath] = process.argv.slice(2);
const chromePath = process.env.CHROME_PATH;

if (!htmlPath || !selector || !noAgendaPath) {
  throw new Error("usage: check_reveal_fixture.mjs HTML SELECTOR NO_AGENDA_HTML");
}
if (!existsSync(htmlPath)) {
  throw new Error(`rendered deck does not exist: ${htmlPath}`);
}
if (!existsSync(noAgendaPath)) {
  throw new Error(`rendered no-agenda deck does not exist: ${noAgendaPath}`);
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

  deckUrl.search = "?handout=true";
  await openReadyDeck(page, deckUrl.href);
  const handout = await page.evaluate(() => {
    const notes = document.querySelector(".slides aside.notes");
    return {
      active: document.documentElement.classList.contains("altmejd-handout"),
      notesVisible: notes !== null && getComputedStyle(notes).display !== "none",
    };
  });
  console.log(JSON.stringify({ handout }));
  if (!handout.active || !handout.notesVisible) {
    throw new Error("handout mode did not expose speaker notes");
  }

  await openReadyDeck(page, pathToFileURL(noAgendaPath).href);
  const disabledAgendaSlides = await page.$$eval(
    ".slides section.agenda-slide",
    (elements) => elements.length,
  );
  if (disabledAgendaSlides !== 0) {
    throw new Error(`agenda.enabled=false produced ${disabledAgendaSlides} agenda slides`);
  }
} finally {
  await browser.close();
}
