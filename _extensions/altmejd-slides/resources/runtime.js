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
    Array.from(slide.children).find((child) => child.matches(".slide-nav"));

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

  // During Reveal's 3D transitions (convex, concave, zoom) the incoming slide
  // is measured while rotated or scaled, so getBoundingClientRect() disagrees
  // with layout size and the reserved heights come out garbage — collapsing
  // stretched images to zero. Detect the distortion and wait for the
  // slidetransitionend re-measure instead.
  const isMidTransition = (slide) => {
    if (slide.offsetWidth === 0) {
      // Hidden or not laid out: every rect is zero and the overlap math
      // would clamp stretched media to nothing.
      return true;
    }
    const scale = window.Reveal?.getScale?.() || 1;
    const rect = slide.getBoundingClientRect();
    const width = slide.offsetWidth * scale;
    const height = slide.offsetHeight * scale;
    return (
      Math.abs(rect.width - width) > width * 0.02 ||
      (height > 0 && Math.abs(rect.height - height) > height * 0.02)
    );
  };

  const updateSlide = (slide) => {
    if (!slide) {
      return;
    }
    if (isMidTransition(slide)) {
      return false;
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

  let frame = null;
  const queueUpdate = (slide, attempt = 0) => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null;
        const skipped = updateSlide(slide ?? window.Reveal?.getCurrentSlide?.()) === false;
        // A skipped measurement outside a CSS transition (a fullscreen or
        // resize re-layout race) gets no slidetransitionend; retry briefly.
        if (skipped && attempt < 8) {
          setTimeout(() => queueUpdate(slide, attempt + 1), 150);
        }
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

    // Measure synchronously so late-loading media is reflected before the
    // caller's next frame; fall back to the queue (which retries) only when
    // the slide's geometry is distorted mid-transition.
    const resizeObserver = new ResizeObserver(() => {
      const slide = window.Reveal?.getCurrentSlide?.();
      if (slide && updateSlide(slide) === false) {
        queueUpdate(slide);
      }
    });
    // Reveal assigns lazy `data-src` images their real src only when a slide
    // comes within view distance, so the network request often fires at
    // reveal time. If that request fails (flaky venue Wi-Fi), the image ends
    // up complete-but-empty and neither the browser nor Reveal ever retries:
    // the slide stays blank. Re-request broken images on the current slide —
    // once immediately and then on a short backoff — and rerun Reveal's
    // stretch layout when a retry succeeds.
    const MEDIA_RETRY_DELAYS = [1500, 4000, 10000];
    let mediaRetry = { timer: null, attempt: 0 };

    const brokenImages = (slide) =>
      Array.from(slide.querySelectorAll("img")).filter((img) => {
        const source = img.getAttribute("src");
        return img.complete && img.naturalWidth === 0 && source && !source.startsWith("data:");
      });

    const retryBrokenImages = (slide) => {
      const broken = brokenImages(slide);
      broken.forEach((img) => {
        const source = img.getAttribute("src");
        img.addEventListener(
          "load",
          () => {
            window.Reveal?.layout?.();
            queueUpdate(slide);
          },
          { once: true },
        );
        // Setting an identical src is a no-op; remove it first so the load
        // algorithm runs again with the original, cacheable URL.
        img.removeAttribute("src");
        img.setAttribute("src", source);
      });
      return broken.length;
    };

    const scheduleMediaRecovery = (slide) => {
      if (mediaRetry.timer !== null || mediaRetry.attempt >= MEDIA_RETRY_DELAYS.length) {
        return;
      }
      mediaRetry.timer = setTimeout(() => {
        mediaRetry.timer = null;
        mediaRetry.attempt += 1;
        if (retryBrokenImages(slide) > 0) {
          scheduleMediaRecovery(slide);
        }
      }, MEDIA_RETRY_DELAYS[mediaRetry.attempt]);
    };

    const recoverBrokenMedia = (slide) => {
      if (mediaRetry.timer !== null) {
        clearTimeout(mediaRetry.timer);
      }
      mediaRetry = { timer: null, attempt: 0 };
      if (retryBrokenImages(slide) > 0) {
        scheduleMediaRecovery(slide);
      }
    };

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
          media.addEventListener(
            "error",
            () => {
              queueUpdate(slide);
              // An in-flight request that fails after reveal joins the same
              // backoff chain instead of retrying immediately (no tight loop).
              if (media.matches("img")) {
                scheduleMediaRecovery(slide);
              }
            },
            { once: true },
          );
        }
      });
    };

    window.Reveal.on("ready", (event) => {
      observeSlideBoxes(event.currentSlide);
      queueUpdate(event.currentSlide);
      recoverBrokenMedia(event.currentSlide);
    });
    window.Reveal.on("slidechanged", (event) => {
      observeSlideBoxes(event.currentSlide);
      queueUpdate(event.currentSlide);
      recoverBrokenMedia(event.currentSlide);
    });
    window.addEventListener("online", () => {
      const slide = window.Reveal?.getCurrentSlide?.();
      if (slide) {
        recoverBrokenMedia(slide);
      }
    });
    // Animated transitions settle after slidechanged; measure again once the
    // slide's geometry is final. Fires only when a CSS transition actually ran.
    window.Reveal.on("slidetransitionend", (event) => {
      queueUpdate(event.currentSlide);
    });

    if (window.Reveal.isReady?.()) {
      const slide = window.Reveal.getCurrentSlide();
      observeSlideBoxes(slide);
      queueUpdate(slide);
      recoverBrokenMedia(slide);
    }

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => queueUpdate());
    }
    window.addEventListener("resize", () => queueUpdate(), { passive: true });
  });
})();
