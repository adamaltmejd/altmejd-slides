// Unit tests for the pure Cloudflare publishing logic. Run with `bun test`.
import { describe, expect, test } from "bun:test";

import {
  collectAssetRefs,
  collectCssRefs,
  deckWranglerConfig,
  deriveZone,
  headersFileContent,
  planStaging,
  publicUrl,
  rebaseAssetRefs,
  resolveArtifacts,
  resolveInput,
  resolveStagingRef,
  resolveTarget,
  routePatterns,
  sanitizeSlug,
  validateSlug,
  workerName,
} from "../../_extensions/altmejd-slides/tools/publish/core";

const META = { host: "slides.altmejd.se" };

describe("slug derivation", () => {
  test("sanitizes a QMD stem into a slug", () => {
    expect(sanitizeSlug("UCLS 2026_talk")).toBe("ucls-2026-talk");
    expect(sanitizeSlug("Åre--Vinter")).toBe("re-vinter");
    expect(sanitizeSlug("-lead-and-trail-")).toBe("lead-and-trail");
  });

  test("rejects malformed and reserved slugs", () => {
    expect(validateSlug("ucls26")).toBeNull();
    expect(validateSlug("")).not.toBeNull();
    expect(validateSlug("UCLS")).not.toBeNull();
    expect(validateSlug("a/b")).not.toBeNull();
    expect(validateSlug("-lead")).not.toBeNull();
    expect(validateSlug("trail-")).not.toBeNull();
    expect(validateSlug("index")).not.toBeNull();
    expect(validateSlug("a".repeat(60))).not.toBeNull();
  });
});

describe("target resolution", () => {
  test("derives the slug from the repository name by default", () => {
    const target = resolveTarget({ metadata: META, cliSlug: undefined, projectName: "My Talk" });
    expect(target).toEqual({ host: "slides.altmejd.se", zone: "altmejd.se", slug: "my-talk" });
  });

  test("host defaults to slides.altmejd.se and YAML overrides it", () => {
    expect(resolveTarget({ metadata: undefined, cliSlug: undefined, projectName: "t" })).toEqual({
      host: "slides.altmejd.se",
      zone: "altmejd.se",
      slug: "t",
    });
    expect(
      resolveTarget({
        metadata: { host: "talks.example.org" },
        cliSlug: undefined,
        projectName: "t",
      }),
    ).toEqual({ host: "talks.example.org", zone: "example.org", slug: "t" });
  });

  test("YAML slug beats the repo name and the CLI flag beats YAML", () => {
    const yaml = resolveTarget({
      metadata: { ...META, slug: "ucls26" },
      cliSlug: undefined,
      projectName: "talk",
    });
    expect(yaml).toEqual(expect.objectContaining({ slug: "ucls26" }));
    const cli = resolveTarget({
      metadata: { ...META, slug: "ucls26" },
      cliSlug: "override",
      projectName: "talk",
    });
    expect(cli).toEqual(expect.objectContaining({ slug: "override" }));
  });

  test("validates the zone relationship and apex hosts", () => {
    expect(
      resolveTarget({
        metadata: { host: "slides.altmejd.se", zone: "example.com" },
        cliSlug: undefined,
        projectName: "t",
      }),
    ).toHaveProperty("error");
    expect(
      resolveTarget({ metadata: { host: "altmejd.se" }, cliSlug: undefined, projectName: "t" }),
    ).toHaveProperty("error");
  });

  test("derives the zone by stripping the first host label", () => {
    expect(deriveZone("slides.altmejd.se")).toBe("altmejd.se");
    expect(deriveZone("altmejd.se")).toBeNull();
    expect(deriveZone("a..se")).toBeNull();
  });

  test("rejects an invalid explicit slug", () => {
    expect(
      resolveTarget({ metadata: META, cliSlug: "Bad Slug", projectName: "talk" }),
    ).toHaveProperty("error");
  });
});

describe("input resolution", () => {
  test("uses the only QMD, requires --input otherwise", () => {
    expect(resolveInput(["talk.qmd"], undefined)).toBe("talk.qmd");
    expect(resolveInput(["a.qmd", "b.qmd"], undefined)).toHaveProperty("error");
    expect(resolveInput([], undefined)).toHaveProperty("error");
    expect(resolveInput(["a.qmd", "b.qmd"], "b.qmd")).toBe("b.qmd");
  });
});

describe("artifact configuration", () => {
  test("absent config publishes nothing extra", () => {
    expect(resolveArtifacts(undefined)).toEqual([]);
  });

  test("resolves explicit artifacts with target defaulting to the source basename", () => {
    expect(
      resolveArtifacts({
        "presentation-pdf": { source: "_site/talk-slides.pdf", target: "slides.pdf" },
        "handout-pdf": { source: "_site/talk-handout.pdf" },
      }),
    ).toEqual([
      { name: "handout-pdf", source: "_site/talk-handout.pdf", target: "talk-handout.pdf" },
      { name: "presentation-pdf", source: "_site/talk-slides.pdf", target: "slides.pdf" },
    ]);
  });

  test("rejects unsafe sources and targets", () => {
    expect(resolveArtifacts({ a: {} })).toHaveProperty("error");
    expect(resolveArtifacts({ a: { source: "/etc/passwd" } })).toHaveProperty("error");
    expect(resolveArtifacts({ a: { source: "../outside.pdf" } })).toHaveProperty("error");
    expect(resolveArtifacts({ a: { source: "x.pdf", target: "../up.pdf" } })).toHaveProperty(
      "error",
    );
    expect(resolveArtifacts({ a: { source: "x.pdf", target: "/abs.pdf" } })).toHaveProperty(
      "error",
    );
    expect(resolveArtifacts({ a: { source: "x.html", target: "index.html" } })).toHaveProperty(
      "error",
    );
    expect(resolveArtifacts("pdf")).toHaveProperty("error");
  });

  test("allows nested targets with safe segments", () => {
    expect(resolveArtifacts({ a: { source: "out/x.pdf", target: "pdf/slides.pdf" } })).toEqual([
      { name: "a", source: "out/x.pdf", target: "pdf/slides.pdf" },
    ]);
  });
});

describe("worker naming and routes", () => {
  test("worker and route names are deterministic", () => {
    expect(workerName("ucls26")).toBe("altmejd-slides-ucls26");
    expect(routePatterns("slides.altmejd.se", "ucls26")).toEqual([
      "slides.altmejd.se/ucls26",
      "slides.altmejd.se/ucls26/*",
    ]);
  });

  test("deck wrangler config pins the name, assets, and zone routes", () => {
    const config = deckWranglerConfig({
      host: "slides.altmejd.se",
      zone: "altmejd.se",
      slug: "x1",
    });
    expect(config.name).toBe("altmejd-slides-x1");
    expect(config.workers_dev).toBe(false);
    expect(config.assets).toEqual({ directory: "./public" });
    expect(config.routes).toEqual([
      { pattern: "slides.altmejd.se/x1", zone_name: "altmejd.se" },
      { pattern: "slides.altmejd.se/x1/*", zone_name: "altmejd.se" },
    ]);
  });

  test("public URL always carries a trailing slash", () => {
    expect(publicUrl({ host: "slides.altmejd.se", zone: "altmejd.se", slug: "ucls26" })).toBe(
      "https://slides.altmejd.se/ucls26/",
    );
  });
});

describe("asset reference collection", () => {
  const html = `
    <link rel="stylesheet" href="talk_files/libs/revealjs/dist/reveal.css">
    <script src="talk_files/libs/revealjs/dist/reveal.js"></script>
    <img src="assets/estimate.svg">
    <img data-src="assets/lazy.svg">
    <section data-background-image="assets/field.svg"></section>
    <img srcset="assets/small.png 1x, assets/big.png 2x">
    <video poster="assets/poster.png"></video>
    <a href="https://example.com/x">external</a>
    <a href="#/slide-2">hash</a>
    <img src="/absolute.png">
    <img src="data:image/png;base64,AAAA">
    <a href="mailto:adam@altmejd.se">mail</a>
    <img src="assets/query.svg?v=1#frag">
  `;

  test("keeps local relative references and drops the rest", () => {
    expect(collectAssetRefs(html)).toEqual([
      "assets/big.png",
      "assets/estimate.svg",
      "assets/field.svg",
      "assets/lazy.svg",
      "assets/poster.png",
      "assets/query.svg",
      "assets/small.png",
      "talk_files/libs/revealjs/dist/reveal.css",
      "talk_files/libs/revealjs/dist/reveal.js",
    ]);
  });

  test("decodes percent-encoding and matches uppercase and background media", () => {
    const html = `
      <IMG SRC="assets/UP.png">
      <img src="assets/my%20figure.png">
      <section data-background-video="assets/clip.mp4"></section>
      <section data-background-iframe="assets/embed.html"></section>
      <img src="assets/q%3Fmark.svg?v=2">
    `;
    expect(collectAssetRefs(html)).toEqual([
      "assets/UP.png",
      "assets/clip.mp4",
      "assets/embed.html",
      "assets/my figure.png",
      "assets/q?mark.svg",
    ]);
  });

  test("ignores embedded templates and comments but keeps real script sources", () => {
    const inline = [
      '<!-- <img src="private/comment.png"> -->',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Reveal template reproduces the bug.
      '<ScRiPt data-label="a > b">const template = `<iframe src="${e}"></iframe>`;</sCrIpT>',
      `<style>.example::after { content: '<img src="private/style.png">'; }</style>`,
      '<textarea><img src="private/text.png"></textarea>',
    ].join("\n");
    const html = `${inline}<script src="assets/app.js"></script><img alt="a > b" src="assets/a.png">`;
    expect(collectAssetRefs(html)).toEqual(["assets/a.png", "assets/app.js"]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(
      `${inline}<script src="talks/assets/app.js"></script><img alt="a > b" src="talks/assets/a.png">`,
    );
    expect(collectAssetRefs(inline)).toEqual([]);
    expect(rebaseAssetRefs(inline, "discussion.html")).toBe(inline);
  });

  test("does not scan other attribute values, end tags, or ordinary text", () => {
    const before = `<div title='example src="private/a.png" >' data-json='{"href":"private/b.html"}'
      onclick="show('<img src=private/c.png>')" DATA-SRC = 'assets/real.png'>
      literal src="private/d.png"</div href="private/e.html">`;
    expect(collectAssetRefs(before)).toEqual(["assets/real.png"]);
    expect(rebaseAssetRefs(before, "talks/deck.html")).toBe(
      before.replace("'assets/real.png'", "'talks/assets/real.png'"),
    );
  });

  test.each([
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
  ])("preserves %s bodies and resumes only at their matching end tag", (tag) => {
    const body = `<${tag.toUpperCase()} src="app.js" data-label='a > b'>
      <img src="private/inside.png"></${tag}-widget><img src="private/still-inside.png">`;
    const ending = `</${tag.toUpperCase()} data-label="a > b"><img src="after.png">`;
    expect(collectAssetRefs(body + ending)).toEqual(["after.png", "app.js"]);
    expect(rebaseAssetRefs(body + ending, "talks/deck.html")).toBe(
      body.replace('src="app.js"', 'src="talks/app.js"') +
        ending.replace('src="after.png"', 'src="talks/after.png"'),
    );
    // An unterminated body consumes the rest of the document.
    expect(collectAssetRefs(body)).toEqual(["app.js"]);
    expect(rebaseAssetRefs(body, "talks/deck.html")).toBe(
      body.replace('src="app.js"', 'src="talks/app.js"'),
    );
  });

  test("recognizes complete tag names, unquoted values, and HTML template content", () => {
    const html = `<script-widget><IMG hidden SrC=assets/a.png></script-widget>
      <template><img DATA-SRCSET='assets/small.png 1x, assets/large.png 2x'></template>`;
    expect(collectAssetRefs(html)).toEqual([
      "assets/a.png",
      "assets/large.png",
      "assets/small.png",
    ]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(
      html.replaceAll("assets/", "talks/assets/"),
    );
  });

  test.each([
    '<!-- <img src="private/a.png">',
    '<img title="unfinished > <img src=private/a.png>',
    '<img src="unfinished.png"',
    '<plaintext><img src="private/a.png"></plaintext><img src="private/b.png">',
    '<![CDATA[<img src="private/a.png">]]>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template reproduces the bug.
    '<script>const template = `<img src="${e}">`;',
  ])("preserves non-markup and unfinished tokens: %s", (html) => {
    expect(collectAssetRefs(html)).toEqual([]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(html);
  });

  test("handles script escaping and comment endings without consuming later assets", () => {
    const ignored = `<script><!-- const template = '<script></script><img src="private/a.png">'; --></script>
      <!-- <img src="private/b.png"> --!><!--><!--->`;
    const html = `${ignored}<img src="after.png">`;
    expect(collectAssetRefs(html)).toEqual(["after.png"]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(`${ignored}<img src="talks/after.png">`);
  });

  test("keeps assets after self-closing SVG elements and inside foreign HTML content", () => {
    const html = `<svg><script href="assets/svg.js"/><style/><title/>
      <foreignObject><script>const template = '<img src="ignored.png">';</script>
        <img src="assets/inside.png"></foreignObject>
      <image href="assets/image.svg"/>
      <![CDATA[text > <img src="ignored-cdata.png">]]></svg>
      <math><mtext><img src="assets/math.png"></mtext></math>
      <img src="assets/after.png">`;
    expect(collectAssetRefs(html)).toEqual([
      "assets/after.png",
      "assets/image.svg",
      "assets/inside.png",
      "assets/math.png",
      "assets/svg.js",
    ]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(
      html.replaceAll("assets/", "talks/assets/"),
    );
    // HTML ignores the self-closing flag on script, unlike SVG.
    const script = '<script/><img src="ignored.png">';
    expect(collectAssetRefs(script)).toEqual([]);
    expect(rebaseAssetRefs(script, "talks/deck.html")).toBe(script);
    const cdata = '<![CDATA[text ><img src="real.png">]]>';
    expect(collectAssetRefs(cdata)).toEqual(["real.png"]);
    expect(rebaseAssetRefs(cdata, "talks/deck.html")).toBe(
      cdata.replace('src="real.png"', 'src="talks/real.png"'),
    );
  });

  test("keeps data URL srcsets intact while collecting and rebasing local candidates", () => {
    const html = `<img srcset="data:image/png;base64,AAAA 1x, assets/large.png 2x">
      <img data-srcset='assets/small.png 1x, data:image/svg+xml,%3Csvg%3E,%3C/svg%3E 2x'>
      <img srcset="data:image/png;base64,BBBB">
      <img srcset="assets/one.png, assets/two.png 2x,">`;
    expect(collectAssetRefs(html)).toEqual([
      "assets/large.png",
      "assets/one.png",
      "assets/small.png",
      "assets/two.png",
    ]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(
      html.replaceAll("assets/", "talks/assets/"),
    );
  });

  test("handles SVG in MathML annotations and HTML children of integration points", () => {
    const script = `<script>const template = '<img src="ignored.png">';</script>`;
    const html = `<math><annotation-xml encoding="image/svg+xml"><svg>
      <foreignObject><mglyph>${script}<img src="assets/svg.png"></mglyph></foreignObject>
      </svg></annotation-xml>
      <annotation-xml encoding="text/html"><malignmark>${script}
        <img src="assets/math.png"></malignmark></annotation-xml></math>`;
    expect(collectAssetRefs(html)).toEqual(["assets/math.png", "assets/svg.png"]);
    expect(rebaseAssetRefs(html, "talks/deck.html")).toBe(
      html.replaceAll("assets/", "talks/assets/"),
    );
  });

  test("real references still reach staging validation even beside ignored templates", () => {
    const html = `<script>const template = '<img src="ignored.png">';</script>
      <img title='example src="ignored-too.png"' src="missing.png">
      <img data-src="%2e%2e/secret.png" srcset="../../outside.png 2x">`;
    expect(planStaging(collectAssetRefs(html))).toEqual({
      files: ["missing.png"],
      directories: [],
      outside: ["../../outside.png", "../secret.png"],
    });
  });

  test("collects relative url() and @import targets from stylesheets", () => {
    const css = `
      @import "theme/extra.css";
      body { background: url(images/bg%20light.png); }
      .hero { background-image: url("images/hero.jpg"); }
      .icon { content: url('icon.svg'); }
      .cdn { background: url(https://cdn.example.com/x.png); }
      .inline { background: url(data:image/png;base64,AAAA); }
      .abs { background: url(/absolute.png); }
    `;
    expect(collectCssRefs(css)).toEqual([
      "icon.svg",
      "images/bg light.png",
      "images/hero.jpg",
      "theme/extra.css",
    ]);
  });

  test("decodes HTML entities without double-decoding", () => {
    expect(collectAssetRefs('<img src="assets/a&amp;b.png">')).toEqual(["assets/a&b.png"]);
    expect(collectAssetRefs('<img src="assets/a&amp;quot;.png">')).toEqual(["assets/a&quot;.png"]);
  });

  test("staging copies referenced directories wholesale and flags escapes", () => {
    const plan = planStaging([
      "talk_files/libs/revealjs/dist/reveal.css",
      "talk_files/libs/quarto-html/quarto.js",
      "assets/estimate.svg",
      "portrait.jpg",
      "../secrets.txt",
    ]);
    expect(plan.directories).toEqual(["assets", "talk_files"]);
    expect(plan.files).toEqual(["portrait.jpg"]);
    expect(plan.outside).toEqual(["../secrets.txt"]);
  });

  test("dot paths cannot select the output root for wholesale copying", () => {
    expect(planStaging(["./dot.svg", "./assets/plot.svg", "assets/../portrait.svg"])).toEqual({
      directories: ["assets"],
      files: ["dot.svg", "portrait.svg"],
      outside: [],
    });
    expect(planStaging([".", "./", "assets/..", "assets/../"])).toEqual({
      directories: [],
      files: [],
      outside: [".", "./", "assets/..", "assets/../"],
    });
  });

  test("nested decks resolve shared assets without copying their whole parent", () => {
    expect(
      planStaging(
        ["./plot.svg", "assets/image.svg", "../site_libs/revealjs/reveal.js", "../../secret.txt"],
        "talks",
      ),
    ).toEqual({
      directories: ["site_libs", "talks/assets"],
      files: ["talks/plot.svg"],
      outside: ["../../secret.txt"],
    });
    expect(resolveStagingRef("../../secret.txt", "talks")).toBeNull();
    expect(resolveStagingRef("..\\site_libs\\font.woff2", "talks")).toBe("site_libs/font.woff2");
  });

  test("entry relocation preserves encoded assets, srcsets, and self links", () => {
    const rebased = rebaseAssetRefs(
      `
      <link href="../site_libs/style.css">
      <img data-src="./my%20figure%3F.svg?v=1&amp;x=2#part">
      <img srcset="a.svg 1x, ../b.svg 2x,">
      <a href="talk.html#/result">result</a>
      <a href="#/result">slide</a><a href="https://example.org/paper">paper</a>
    `,
      "talks/talk.html",
    );
    expect(rebased).toContain('href="site_libs/style.css"');
    expect(rebased).toContain('data-src="talks/my%20figure%3F.svg?v=1&amp;x=2#part"');
    expect(rebased).toContain('srcset="talks/a.svg 1x, b.svg 2x,"');
    expect(rebased).toContain('href="index.html#/result"');
    expect(rebased).toContain('href="#/result"');
    expect(rebased).toContain('href="https://example.org/paper"');
  });

  test("CSS preflight ignores disabled resource declarations", () => {
    expect(collectCssRefs('/* url(missing.png) */ @import "kept.css";')).toEqual(["kept.css"]);
  });

  test("asset headers allow stale service on failed revalidation", () => {
    const lines = headersFileContent().split("\n");
    expect(lines[0]).toBe("/*");
    expect(lines[1]).toMatch(/^ {2}Cache-Control: /);
    expect(lines[1]).toContain("stale-while-revalidate");
    expect(lines[1]).not.toContain("must-revalidate");
    // The Workers _headers parser caps each line at 2000 characters.
    for (const line of lines) {
      expect(line.length).toBeLessThan(2000);
    }
  });
});
