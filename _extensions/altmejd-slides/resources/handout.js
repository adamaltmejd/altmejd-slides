(() => {
  const value = new URLSearchParams(window.location.search).get("handout");
  const handout = value !== null && value !== "false" && value !== "0";

  if (!handout) {
    return;
  }

  document.documentElement.classList.add("altmejd-handout");

  // Quarto's line-highlight clones are Reveal fragments. They can leave a
  // handout capture showing only one highlighted step, so remove the source
  // attribute before Reveal initializes whenever this script loads in time.
  const stripLineHighlights = (root) => {
    if (root.nodeType !== Node.ELEMENT_NODE && root !== document) {
      return;
    }
    if (root.matches?.("div.sourceCode[data-code-line-numbers]")) {
      root.removeAttribute("data-code-line-numbers");
    }
    root.querySelectorAll("div.sourceCode[data-code-line-numbers]").forEach((element) => {
      element.removeAttribute("data-code-line-numbers");
    });
  };

  stripLineHighlights(document);
  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach(stripLineHighlights);
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const directNote = (slide) =>
    Array.from(slide.children).find((child) => child.matches("aside.notes"));

  const directAside = (slide) =>
    Array.from(slide.children).find(
      (child) => !child.matches(".notes") && child.matches(".aside, aside:not(.notes)"),
    );

  const updateSlide = (slide) => {
    if (!slide) {
      return;
    }

    const note = directNote(slide);
    const aside = directAside(slide);
    slide.classList.toggle("has-handout-notes", Boolean(note));
    slide.classList.toggle("has-handout-aside", Boolean(aside));

    if (note) {
      slide.style.setProperty(
        "--altmejd-handout-note-height",
        `${Math.ceil(note.getBoundingClientRect().height)}px`,
      );
      note.classList.toggle("is-overflowing", note.scrollHeight > note.clientHeight + 2);
    } else {
      slide.style.removeProperty("--altmejd-handout-note-height");
    }

    if (aside) {
      slide.style.setProperty(
        "--altmejd-handout-aside-height",
        `${Math.ceil(aside.getBoundingClientRect().height)}px`,
      );
      aside.classList.toggle("is-overflowing", aside.scrollHeight > aside.clientHeight + 2);
    } else {
      slide.style.removeProperty("--altmejd-handout-aside-height");
    }

    slide.querySelectorAll("pre").forEach((pre) => {
      pre.classList.toggle("is-overflowing", pre.scrollHeight > pre.clientHeight + 2);
    });
  };

  const updateCurrentSlide = () => {
    if (window.Reveal && typeof window.Reveal.getCurrentSlide === "function") {
      updateSlide(window.Reveal.getCurrentSlide());
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    observer.disconnect();
    stripLineHighlights(document);
    document.body.classList.add("altmejd-handout");

    if (!window.Reveal) {
      return;
    }

    window.Reveal.on("ready", (event) => {
      updateSlide(event.currentSlide);
    });
    window.Reveal.on("slidechanged", (event) => {
      requestAnimationFrame(() => {
        updateSlide(event.currentSlide);
      });
    });

    if (window.Reveal.isReady?.()) {
      updateCurrentSlide();
    }

    if (document.fonts?.ready) {
      document.fonts.ready.then(updateCurrentSlide);
    }
    window.addEventListener("resize", updateCurrentSlide, { passive: true });
  });
})();
