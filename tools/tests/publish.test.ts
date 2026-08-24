// Unit tests for the pure Cloudflare publishing logic. Run with `bun test`.
import { describe, expect, test } from "bun:test";

import {
  collectAssetRefs,
  collectCssRefs,
  deckWranglerConfig,
  deriveZone,
  gatewayWranglerConfig,
  planStaging,
  publicUrl,
  resolveInput,
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

  test("gateway config claims the host as a custom domain", () => {
    const config = gatewayWranglerConfig("slides.altmejd.se", "altmejd.se");
    expect(config.name).toBe("altmejd-slides-gateway");
    expect(config.routes).toEqual([{ pattern: "slides.altmejd.se", custom_domain: true }]);
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
});
