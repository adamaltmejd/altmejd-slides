(() => {
  const value = new URLSearchParams(window.location.search).get("handout");
  const handout = value !== null && value !== "false" && value !== "0";

  if (handout) {
    document.documentElement.classList.add("altmejd-handout");
  }

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

  let mutationObserver = null;
  if (handout) {
    stripLineHighlights(document);
    mutationObserver = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach(stripLineHighlights);
      });
    });
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  const directNote = (slide) =>
    Array.from(slide.children).find((child) => child.matches("aside.notes"));

  const directAside = (slide) =>
    Array.from(slide.children).find(
      (child) => !child.matches(".notes") && child.matches(".aside, aside:not(.notes)"),
    );

  const directNavigation = (slide) =>
    Array.from(slide.children).find((child) => child.matches(".slide-nav, .slide-links"));

  const setMeasuredHeight = (slide, property, element) => {
    if (element) {
      const scale = window.Reveal?.getScale?.() || 1;
      slide.style.setProperty(
        property,
        `${Math.ceil(element.getBoundingClientRect().height / scale)}px`,
      );
      element.classList.toggle("is-overflowing", element.scrollHeight > element.clientHeight + 2);
    } else {
      slide.style.removeProperty(property);
    }
  };

  const reserveStretchArea = (slide, boundary) => {
    const stretched = Array.from(slide.children).filter((child) =>
      child.matches(".r-stretch, .stretch"),
    );
    stretched.forEach((element) => {
      element.style.removeProperty("--altmejd-stretch-max-height");
    });
    if (!boundary || stretched.length === 0) {
      return;
    }

    const scale = window.Reveal?.getScale?.() || 1;
    const boundaryTop = boundary.getBoundingClientRect().top - 6 * scale;
    const content = Array.from(slide.children).filter((child) => {
      if (child === boundary || child.matches("aside.notes, .attribution")) {
        return false;
      }
      const style = getComputedStyle(child);
      return (
        style.display !== "none" && style.visibility !== "hidden" && style.position !== "absolute"
      );
    });
    const contentBottom = Math.max(
      slide.getBoundingClientRect().top,
      ...content.map((child) => child.getBoundingClientRect().bottom),
    );
    const overlap = contentBottom - boundaryTop;
    if (overlap <= 0) {
      return;
    }

    const element = stretched.reduce((largest, candidate) =>
      candidate.getBoundingClientRect().height > largest.getBoundingClientRect().height
        ? candidate
        : largest,
    );
    const height = element.getBoundingClientRect().height;
    element.style.setProperty(
      "--altmejd-stretch-max-height",
      `${Math.max(0, (height - overlap) / scale)}px`,
    );
  };

  const updateSlide = (slide) => {
    if (!slide) {
      return;
    }

    const aside = directAside(slide);
    const note = handout ? directNote(slide) : null;
    const navigation = directNavigation(slide);

    slide.classList.toggle("has-altmejd-aside", Boolean(aside));
    slide.classList.toggle("has-handout-notes", Boolean(note));
    slide.classList.toggle("has-altmejd-navigation", Boolean(navigation));
    setMeasuredHeight(slide, "--altmejd-aside-height", aside);
    setMeasuredHeight(slide, "--altmejd-handout-note-height", note);
    setMeasuredHeight(slide, "--altmejd-navigation-height", navigation);
    reserveStretchArea(slide, aside ?? note ?? navigation);

    slide.querySelectorAll("pre").forEach((pre) => {
      pre.classList.toggle("is-overflowing", pre.scrollHeight > pre.clientHeight + 2);
    });
  };

  const updateCurrentSlide = () => {
    if (window.Reveal && typeof window.Reveal.getCurrentSlide === "function") {
      updateSlide(window.Reveal.getCurrentSlide());
    }
  };

  let frame = null;
  const queueUpdate = (slide) => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        updateSlide(slide ?? window.Reveal?.getCurrentSlide?.());
      });
    });
  };

  document.addEventListener("DOMContentLoaded", () => {
    mutationObserver?.disconnect();
    if (handout) {
      stripLineHighlights(document);
      document.body.classList.add("altmejd-handout");
    }

    if (!window.Reveal) {
      return;
    }

    // Reveal 5.1 enables scroll view below 435 px, but Quarto's vertical
    // section stacks are not valid scroll pages. Keep the scaled slide canvas
    // on phones until Quarto exposes a reliable format-level override.
    window.Reveal.configure({ scrollActivationWidth: 0 });

    const resizeObserver = new ResizeObserver(updateCurrentSlide);
    const observeSlideBoxes = (slide) => {
      resizeObserver.disconnect();
      const aside = directAside(slide);
      const note = handout ? directNote(slide) : null;
      const navigation = directNavigation(slide);
      if (aside) {
        resizeObserver.observe(aside);
      }
      if (note) {
        resizeObserver.observe(note);
      }
      if (navigation) {
        resizeObserver.observe(navigation);
      }
      slide.querySelectorAll("img, video, iframe").forEach((media) => {
        resizeObserver.observe(media);
        const awaitingImage = media.matches("img") && (!media.complete || media.naturalWidth === 0);
        const awaitingVideo = media.matches("video") && media.readyState < 1;
        if (awaitingImage || awaitingVideo) {
          const eventName = awaitingVideo ? "loadedmetadata" : "load";
          media.addEventListener(
            eventName,
            () => {
              window.Reveal?.layout?.();
              queueUpdate(slide);
            },
            { once: true },
          );
          media.addEventListener("error", () => queueUpdate(slide), { once: true });
        }
      });
    };

    window.Reveal.on("ready", (event) => {
      observeSlideBoxes(event.currentSlide);
      queueUpdate(event.currentSlide);
    });
    window.Reveal.on("slidechanged", (event) => {
      observeSlideBoxes(event.currentSlide);
      queueUpdate(event.currentSlide);
    });

    if (window.Reveal.isReady?.()) {
      const slide = window.Reveal.getCurrentSlide();
      observeSlideBoxes(slide);
      queueUpdate(slide);
    }

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => queueUpdate());
    }
    window.addEventListener("resize", () => queueUpdate(), { passive: true });
  });
})();
