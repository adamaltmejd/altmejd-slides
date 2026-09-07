(() => {
  const params = new URLSearchParams(location.search);
  const reading = document.documentElement.classList.contains("altmejd-reading");
  const handout = document.documentElement.classList.contains("altmejd-handout");
  const requestedHash = location.hash;
  const checking = params.has("check") && !["false", "0"].includes(params.get("check"));
  if (params.has("pdf") || (checking && !reading)) return;

  const modeUrl = (enabled) => {
    const url = new URL(location.href);
    if (enabled) {
      url.searchParams.set("reading", "true");
      // Reveal emits slidechanged before updating location.hash.
      const slideId = window.Reveal?.getCurrentSlide()?.id;
      if (slideId) url.hash = `#/${slideId}`;
    } else {
      url.searchParams.delete("reading");
      if (url.hash && !url.hash.startsWith("#/")) url.hash = `#/${url.hash.slice(1)}`;
    }
    return url.href;
  };

  const anchor = (text, href, className) => {
    const link = document.createElement("a");
    link.textContent = text;
    link.href = href;
    link.className = className;
    return link;
  };

  const gated = (element) => Boolean(element.closest(handout ? ".live-only" : ".handout-only"));

  const installControls = () => {
    const read = anchor("Read slides", modeUrl(true), "altmejd-read-link");
    document.body.append(read);
    // Replace Quarto's scroll-view entry: its native vertical stacks do not
    // form useful scroll pages. The reader has ordinary document semantics.
    const menuRead = document.querySelector('a[onclick*="toggleScrollView"]');
    if (menuRead) {
      menuRead.removeAttribute("onclick");
      menuRead.href = modeUrl(true);
      menuRead.textContent = "Read slides";
    }

    const navigation = document.createElement("nav");
    navigation.className = "altmejd-mobile-nav";
    navigation.setAttribute("aria-label", "Links on this slide");
    document.body.append(navigation);
    const update = () => {
      read.href = modeUrl(true);
      if (menuRead) menuRead.href = read.href;
      navigation.replaceChildren();
      const slide = window.Reveal.getCurrentSlide();
      slide.querySelectorAll(":scope > .slide-nav a").forEach((source) => {
        if (gated(source)) return;
        const link = source.cloneNode(true);
        link.removeAttribute("id");
        navigation.append(link);
      });
      navigation.hidden = navigation.children.length === 0;
      document.documentElement.classList.toggle("altmejd-mobile-links", !navigation.hidden);
    };
    navigation.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return;
      const target = document.getElementById(decodeURIComponent(url.hash.replace(/^#\/?/, "")));
      if (!target) return;
      event.preventDefault();
      const { h, v } = window.Reveal.getIndices(target.closest("section"));
      window.Reveal.slide(h, v);
    });
    window.Reveal.on("slidechanged", update);
    update();
  };

  const buildReader = async () => {
    const reveal = window.Reveal;
    const source = reveal.getRevealElement();
    const main = document.createElement("main");
    main.className = "altmejd-reader";
    main.setAttribute("aria-label", document.title);
    const toolbar = document.createElement("nav");
    toolbar.className = "altmejd-reader-toolbar";
    toolbar.setAttribute("aria-label", "Reading options");
    const back = anchor("Present slides", modeUrl(false), "");
    const print = document.createElement("button");
    print.type = "button";
    print.textContent = "Print / save PDF";
    print.addEventListener("click", () => window.print());
    toolbar.append(back, print);
    main.append(toolbar);

    const slides = Array.from(source.querySelectorAll(".slides section")).filter(
      (slide) => !slide.querySelector(":scope > section"),
    );
    for (const original of slides) {
      if (gated(original)) continue;
      const slide = original.cloneNode(true);
      // cloneNode preserves canvas dimensions but drops the painted chart.
      const canvases = slide.querySelectorAll("canvas");
      original.querySelectorAll("canvas").forEach((canvas, index) => {
        if (canvas.width && canvas.height)
          canvases[index].getContext("2d")?.drawImage(canvas, 0, 0);
      });
      slide.removeAttribute("style");
      slide.removeAttribute("aria-hidden");
      slide.removeAttribute("hidden");
      slide.removeAttribute("inert");
      slide.removeAttribute("tabindex");
      slide.querySelectorAll(handout ? ".live-only" : ".handout-only, aside.notes").forEach((e) => {
        e.remove();
      });
      // Pandoc moves native asides to the end of a slide. In document flow,
      // keep qualifications beside the result, then speaker notes and links.
      for (const selector of [
        ":scope > aside:not(.notes), :scope > .aside, :scope > .altmejd-aside",
        ":scope > aside.notes",
        ":scope > .slide-nav",
      ]) {
        slide.querySelectorAll(selector).forEach((element) => {
          slide.append(element);
        });
      }
      slide.querySelectorAll(".fragment.fade-out").forEach((e) => {
        e.remove();
      });
      slide.querySelectorAll(".r-stack").forEach((stack) => {
        Array.from(stack.children)
          .slice(0, -1)
          .forEach((e) => {
            e.remove();
          });
      });
      slide.querySelectorAll(".fragment").forEach((e) => {
        e.removeAttribute("aria-hidden");
        e.classList.remove("fragment");
      });
      slide.querySelectorAll("img, video, iframe, source").forEach((media) => {
        for (const attr of ["src", "srcset"]) {
          if (media.hasAttribute(`data-${attr}`))
            media.setAttribute(attr, media.getAttribute(`data-${attr}`));
        }
        media.removeAttribute("autoplay");
        if (media.matches("video")) media.setAttribute("controls", "");
        if (media.matches("img.r-stretch, img.stretch")) {
          media.style.removeProperty("width");
          media.style.removeProperty("height");
          media.style.removeProperty("max-height");
        }
      });
      slide.querySelectorAll('a[href^="#"]').forEach((link) => {
        const hash = link.getAttribute("href").replace(/^#\/?/, "");
        const numeric = hash.match(/^(\d+)(?:\/(\d+))?$/);
        const id = numeric
          ? reveal.getSlide(Number(numeric[1]), Number(numeric[2] || 0))?.id
          : hash;
        if (id) link.setAttribute("href", `#${id}`);
      });
      if (original.dataset.backgroundImage) {
        const figure = document.createElement("img");
        figure.src = original.dataset.backgroundImage;
        figure.alt = original.getAttribute("data-background-alt") || "";
        figure.className = "altmejd-reading-background";
        slide.querySelector("h1,h2")?.after(figure);
      }
      const background = original.dataset.backgroundIframe || original.dataset.backgroundVideo;
      if (background) {
        const media = document.createElement(
          original.dataset.backgroundIframe ? "iframe" : "video",
        );
        media.src = original.dataset.backgroundIframe ? background : background.split(",")[0];
        media.title =
          original.getAttribute("data-background-alt") ||
          original.querySelector("h1,h2")?.textContent ||
          "Slide media";
        if (media.matches("video")) media.controls = true;
        media.className = "altmejd-reading-background";
        slide.append(media);
      }
      main.append(slide);
    }

    // Resolve numeric hashes while Reveal still owns the slide hierarchy.
    const rawHash = requestedHash.replace(/^#\/?/, "");
    const numeric = rawHash.match(/^(\d+)(?:\/(\d+))?$/);
    let id;
    try {
      id = numeric
        ? reveal.getSlide(Number(numeric[1]), Number(numeric[2] || 0))?.id
        : decodeURIComponent(rawHash);
    } catch {
      id = "";
    }
    await reveal.destroy();
    source.replaceWith(main);
    document.querySelectorAll(".slide-menu-wrapper").forEach((e) => {
      e.remove();
    });
    if (id && document.getElementById(id)) {
      history.replaceState(null, "", `#${id}`);
      await document.fonts.ready;
      document.getElementById(id).scrollIntoView();
    } else {
      history.replaceState(null, "", location.pathname + location.search);
    }
    back.href = modeUrl(false);
    // Native anchors preserve document history and keyboard navigation.
    window.addEventListener("hashchange", () => {
      back.href = modeUrl(false);
    });
    document.documentElement.dataset.altmejdReaderReady = "true";
  };

  const start = () => {
    if (!window.Reveal) return;
    // Let other ready handlers finish painting charts before snapshotting.
    const ready = () => (reading ? requestAnimationFrame(buildReader) : installControls());
    if (window.Reveal.isReady()) ready();
    else window.Reveal.on("ready", ready);
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
