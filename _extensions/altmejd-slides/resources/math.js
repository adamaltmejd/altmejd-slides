(() => {
  const renderMath = () => {
    if (!window.katex) {
      console.error("Altmejd Slides could not load its bundled KaTeX runtime.");
      return;
    }

    document.querySelectorAll(".altmejd-math").forEach((element) => {
      if (element.dataset.rendered === "true") {
        return;
      }
      window.katex.render(element.textContent, element, {
        displayMode: element.classList.contains("display"),
        output: "htmlAndMathml",
        strict: "warn",
        throwOnError: false,
      });
      element.dataset.rendered = "true";
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderMath, { once: true });
  } else {
    renderMath();
  }
})();
