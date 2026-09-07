(() => {
  const params = new URLSearchParams(location.search);
  if (
    !params.has("check") ||
    ["false", "0"].includes(params.get("check")) ||
    params.has("pdf") ||
    document.documentElement.classList.contains("altmejd-reading")
  )
    return;

  const run = async () => {
    const reveal = window.Reveal;
    const state = reveal.getState();
    const { transition, autoSlide, hash, history } = reveal.getConfig();
    const issues = [];
    const slides = Array.from(document.querySelectorAll(".reveal .slides section")).filter(
      (s) => !s.querySelector(":scope > section"),
    );
    const visible = (e) =>
      e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden";
    const add = (slide, message) =>
      issues.push({
        id: slide.id,
        title: slide.querySelector("h1,h2")?.textContent || slide.id,
        message,
      });
    reveal.configure({ transition: "none", autoSlide: 0, hash: false, history: false });
    for (const slide of slides) {
      const { h, v } = reveal.getIndices(slide);
      reveal.slide(h, v);
      while (reveal.nextFragment()) {
        /* Inspect the final state. */
      }
      await Promise.race([
        Promise.all(
          Array.from(slide.querySelectorAll("img"), (image) => image.decode().catch(() => {})),
        ),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (slide.scrollHeight > slide.clientHeight + 2 || slide.scrollWidth > slide.clientWidth + 2)
        add(slide, "Content overflows the slide.");
      slide.querySelectorAll("pre, .aside, .altmejd-aside, aside.notes").forEach((e) => {
        if (
          visible(e) &&
          (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2)
        )
          add(slide, "Code or notes are clipped; shorten them or split the slide.");
      });
      slide.querySelectorAll("img").forEach((image) => {
        if (!image.hasAttribute("alt")) add(slide, "An image has no alt attribute.");
        if (visible(image) && image.naturalWidth === 0) add(slide, "An image could not be loaded.");
      });
      slide.querySelectorAll('a[href^="#"]').forEach((link) => {
        const value = link.getAttribute("href").replace(/^#\/?/, "");
        if (!value) return;
        let target;
        try {
          target = document.getElementById(decodeURIComponent(value));
        } catch {
          /* Report invalid escapes as broken links. */
        }
        const numeric = value.match(/^(\d+)(?:\/(\d+))?$/);
        if (!target && numeric)
          target = reveal.getSlide(Number(numeric[1]), Number(numeric[2] || 0));
        if (!target) add(slide, `Broken internal link: ${link.getAttribute("href")}`);
      });
    }
    reveal.setState(state);
    reveal.configure({ transition, autoSlide, hash, history });
    window.altmejdSlideReport = { slides: slides.length, issues };
    const dialog = document.createElement("dialog");
    dialog.className = "altmejd-preflight";
    dialog.setAttribute("aria-labelledby", "altmejd-preflight-title");
    const title = document.createElement("h2");
    title.id = "altmejd-preflight-title";
    title.textContent = "Slide check";
    const summary = document.createElement("p");
    summary.textContent = `${slides.length} slides checked; ${issues.length} issue${issues.length === 1 ? "" : "s"} found. This checks layout, image availability, and internal links, not content accuracy or full accessibility.`;
    const list = document.createElement("ul");
    issues.forEach((issue) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `#/${issue.id}`;
      link.textContent = `${issue.title}: ${issue.message}`;
      link.addEventListener("click", () => dialog.close());
      item.append(link);
      list.append(item);
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    dialog.append(title, summary, list, close);
    document.body.append(dialog);
    dialog.showModal();
  };
  const start = () => {
    if (!window.Reveal) return;
    if (window.Reveal.isReady()) run();
    else window.Reveal.on("ready", run);
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
