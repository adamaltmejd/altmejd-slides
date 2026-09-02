// Explicit Cloudflare publisher for altmejd-slides decks. Run from a deck
// directory via `make publish` or directly:
//
//   quarto run _extensions/adamaltmejd/altmejd-slides/tools/publish-cloudflare.ts
//
// Publishing is always a deliberate external action: nothing in the format's
// filters, plugins, or render pipeline invokes this script. See
// docs/publishing.md in the repository for setup and rollback.

import {
  type CloudflareTarget,
  collectAssetRefs,
  collectCssRefs,
  DEFAULT_HOST,
  deckWorkerScript,
  deckWranglerConfig,
  deriveZone,
  gatewayWorkerScript,
  gatewayWranglerConfig,
  headersFileContent,
  type PublishArtifact,
  planStaging,
  publicUrl,
  resolveArtifacts,
  resolveInput,
  resolveTarget,
  validateSlug,
  workerName,
} from "./publish/core.ts";

const STATE_FILE = ".altmejd-slides-publish.json";

interface Options {
  bootstrapGateway: boolean;
  unpublish: boolean;
  input?: string;
  slug?: string;
  host?: string;
  zone?: string;
  stageOnly: boolean;
  stagingDir?: string;
  keepStaging: boolean;
  noVerify: boolean;
  force: boolean;
  adopt: boolean;
}

function usage(): string {
  return [
    "usage: quarto run publish-cloudflare.ts [options]",
    "",
    "  --input <deck.qmd>    deck source (required when several QMDs exist)",
    "  --slug <slug>         override the public path segment",
    "  --bootstrap-gateway   deploy the shared gateway Worker for the host",
    "  --unpublish           delete a talk Worker recorded by this project",
    "  --host <host>         override or supply the publish host",
    "  --zone <zone>         Cloudflare zone (default: host minus first label)",
    "  --stage-only          render, stage, and validate without deploying",
    "  --staging-dir <dir>   use this staging directory instead of a temp dir",
    "  --keep-staging        do not delete the staging directory",
    "  --no-verify           skip the post-deploy URL check",
    "  --adopt               take over an existing Worker with the same name",
    "  --force               redeploy even when content is unchanged",
  ].join("\n");
}

function parseArgs(args: string[]): Options {
  const opts: Options = {
    bootstrapGateway: false,
    unpublish: false,
    stageOnly: false,
    keepStaging: false,
    noVerify: false,
    force: false,
    adopt: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) {
        fail(`missing value for ${arg}\n\n${usage()}`);
      }
      return v;
    };
    switch (arg) {
      case "--bootstrap-gateway":
        opts.bootstrapGateway = true;
        break;
      case "--unpublish":
        opts.unpublish = true;
        break;
      case "--input":
        opts.input = value();
        break;
      case "--slug":
        opts.slug = value();
        break;
      case "--host":
        opts.host = value();
        break;
      case "--zone":
        opts.zone = value();
        break;
      case "--stage-only":
        opts.stageOnly = true;
        break;
      case "--staging-dir":
        opts.stagingDir = value();
        break;
      case "--keep-staging":
        opts.keepStaging = true;
        break;
      case "--no-verify":
        opts.noVerify = true;
        break;
      case "--adopt":
        opts.adopt = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        Deno.exit(0);
        break;
      default:
        fail(`unknown option ${arg}\n\n${usage()}`);
    }
  }
  if (opts.bootstrapGateway && opts.unpublish) {
    fail("--bootstrap-gateway and --unpublish cannot be used together");
  }
  return opts;
}

function fail(message: string): never {
  console.error(`publish-cloudflare: ${message}`);
  Deno.exit(1);
}

async function run(
  cmd: string[],
  opts: { capture?: boolean; cwd?: string; stdin?: "inherit" } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdin: opts.stdin ?? "null",
    stdout: opts.capture ? "piped" : "inherit",
    stderr: opts.capture ? "piped" : "inherit",
  });
  try {
    const result = await command.output();
    const decoder = new TextDecoder();
    return {
      code: result.code,
      stdout: opts.capture ? decoder.decode(result.stdout) : "",
      stderr: opts.capture ? decoder.decode(result.stderr) : "",
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: `command not found: ${cmd[0]}` };
    }
    throw error;
  }
}

async function commandVersion(name: string): Promise<string | null> {
  const probe = await run([name, "--version"], { capture: true });
  return probe.code === 0 ? `${probe.stdout} ${probe.stderr}`.trim() : null;
}

async function commandExists(name: string): Promise<boolean> {
  return (await commandVersion(name)) !== null;
}

// Pinned dependency story: an explicit override, a wrangler 4 already on
// PATH, or the pinned major via bunx/npx. Wrangler 4 is the supported major.
async function resolveWrangler(): Promise<string[]> {
  const override = Deno.env.get("ALTMEJD_SLIDES_WRANGLER");
  if (override !== undefined && override.trim() !== "") {
    return override.trim().split(/\s+/);
  }
  const pathVersion = await commandVersion("wrangler");
  if (pathVersion !== null) {
    if (/\b4\.\d+\.\d+/.test(pathVersion)) {
      return ["wrangler"];
    }
    console.error(`ignoring wrangler on PATH (${pathVersion}): wrangler 4 is the supported major`);
  }
  if (await commandExists("bunx")) {
    return ["bunx", "wrangler@4"];
  }
  if (await commandExists("npx")) {
    return ["npx", "--yes", "wrangler@4"];
  }
  fail(
    "wrangler not found: install wrangler 4 (npm install -g wrangler@4), " +
      "or make bunx/npx available, or set ALTMEJD_SLIDES_WRANGLER",
  );
}

async function inspectDeck(input: string): Promise<{
  outputFile: string;
  outputDir: string;
  cloudflareMeta: Record<string, unknown> | undefined;
}> {
  const result = await run(["quarto", "inspect", input], { capture: true });
  if (result.code !== 0) {
    fail(`quarto inspect ${input} failed:\n${result.stderr}`);
  }
  let inspected: Record<string, unknown>;
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    fail(`quarto inspect ${input} did not return JSON`);
  }
  const formats = (inspected.formats ?? {}) as Record<string, Record<string, unknown>>;
  const formatNames = Object.keys(formats);
  const htmlFormat = formatNames.find((name) => name.includes("revealjs")) ?? formatNames[0];
  if (htmlFormat === undefined) {
    fail(`no output format found for ${input}`);
  }
  const format = formats[htmlFormat];
  const pandoc = (format.pandoc ?? {}) as Record<string, unknown>;
  const outputFile = typeof pandoc["output-file"] === "string" ? pandoc["output-file"] : "";
  if (outputFile === "") {
    fail(`quarto inspect ${input} did not report an output file`);
  }
  const metadata = (format.metadata ?? {}) as Record<string, unknown>;
  const extension = (metadata["altmejd-slides"] ?? {}) as Record<string, unknown>;
  const publish = (extension.publish ?? {}) as Record<string, unknown>;
  const cloudflareMeta = publish.cloudflare as Record<string, unknown> | undefined;
  // A Quarto project renders into project.output-dir (e.g. _site), not next
  // to the source; standalone decks report no project config and use ".".
  const project = (inspected.project ?? {}) as Record<string, unknown>;
  const projectConfig = ((project.config ?? {}) as Record<string, unknown>).project as
    | Record<string, unknown>
    | undefined;
  const rawOutputDir = projectConfig?.["output-dir"];
  const outputDir =
    typeof rawOutputDir === "string" && rawOutputDir.trim() !== "" ? rawOutputDir.trim() : ".";
  return { outputFile, outputDir, cloudflareMeta };
}

// The default slug source: the deck repository's directory name, from the git
// worktree root when available so subdirectories still name the repository.
async function projectName(): Promise<string> {
  const git = await run(["git", "rev-parse", "--show-toplevel"], { capture: true });
  const root = git.code === 0 ? git.stdout.trim() : Deno.cwd();
  const name =
    root
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? "";
  return name;
}

async function listQmdFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(".")) {
    if (entry.isFile && entry.name.endsWith(".qmd") && !entry.name.startsWith(".")) {
      files.push(entry.name);
    }
  }
  return files.sort();
}

async function copyDir(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const source = `${from}/${entry.name}`;
    const destination = `${to}/${entry.name}`;
    // Deno.stat resolves symlinks, so linked assets are copied as content.
    const info = entry.isSymlink ? await Deno.stat(source).catch(() => null) : entry;
    if (info === null) {
      continue; // dangling symlink; a referenced one fails the exists-check
    }
    if (info.isDirectory) {
      await copyDir(source, destination);
    } else if (info.isFile) {
      await Deno.copyFile(source, destination);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

interface DeckRecord {
  worker: string;
  host: string;
  zone?: string;
  contentHash: string;
  published: string;
  // "pending": deployed but the public URL never answered (e.g. DNS still
  // propagating); retried on the next publish without requiring --adopt.
  // Absent means verified (records written by v0.5.0).
  verification?: "ok" | "pending" | "skipped";
}

interface PublishState {
  version: 1;
  decks: Record<string, DeckRecord>;
}

async function readState(): Promise<PublishState> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(STATE_FILE)) as PublishState;
    if (parsed.version === 1 && typeof parsed.decks === "object") {
      return parsed;
    }
  } catch {
    // fall through to a fresh state
  }
  return { version: 1, decks: {} };
}

async function writeState(state: PublishState): Promise<void> {
  await Deno.writeTextFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function hashStagedContent(root: string): Promise<string> {
  const paths: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, rel);
      } else if (entry.isFile) {
        paths.push(rel);
      }
    }
  }
  await walk(root, "");
  paths.sort();
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const rel of paths) {
    chunks.push(encoder.encode(`${rel}\n`));
    chunks.push(await Deno.readFile(`${root}/${rel}`));
  }
  const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", total);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function workerExists(wrangler: string[], name: string): Promise<boolean> {
  const result = await run([...wrangler, "deployments", "list", "--name", name], {
    capture: true,
  });
  if (result.code === 0) {
    return true;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  // Match only Cloudflare's own missing-worker errors, not e.g. a wrapper
  // printing "command not found" for a broken wrangler install.
  if (/service_not_found|script not found|does not exist|\[code: 10007\]/i.test(output)) {
    return false;
  }
  fail(
    `could not query Worker "${name}" (check wrangler login or CLOUDFLARE_API_TOKEN):\n` +
      output.trim(),
  );
}

function envNumber(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// ALTMEJD_SLIDES_VERIFY_BASE redirects verification to another origin (test
// fixtures); ATTEMPTS/DELAY_MS tune the wait for slow DNS propagation.
function verifyUrl(target: CloudflareTarget): string {
  const base = Deno.env.get("ALTMEJD_SLIDES_VERIFY_BASE");
  if (base !== undefined && base.trim() !== "") {
    return `${base.trim().replace(/\/+$/, "")}/${target.slug}/`;
  }
  return publicUrl(target);
}

async function verifyPublished(url: string): Promise<boolean> {
  const attempts = envNumber("ALTMEJD_SLIDES_VERIFY_ATTEMPTS", 6);
  const delayMs = envNumber("ALTMEJD_SLIDES_VERIFY_DELAY_MS", 5000);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      const body = await response.text();
      if (response.ok && /reveal/i.test(body)) {
        console.log(`verified: ${url} serves the deck (HTTP ${response.status})`);
        return true;
      }
      console.error(`attempt ${attempt}/${attempts}: HTTP ${response.status} from ${url}`);
    } catch (error) {
      console.error(`attempt ${attempt}/${attempts}: ${(error as Error).message}`);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function stageDeck(
  entryHtml: string,
  baseDir: string,
  target: CloudflareTarget,
  artifacts: readonly PublishArtifact[],
  stagingDir: string,
): Promise<string> {
  const publicDir = `${stagingDir}/public`;
  const deckDir = `${publicDir}/${target.slug}`;
  // A reused --staging-dir must not keep files deleted from the deck.
  await Deno.remove(publicDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(deckDir, { recursive: true });

  // References in the HTML are relative to the rendered output directory
  // (project.output-dir for Quarto projects, the source directory otherwise).
  const fromBase = (ref: string): string => (baseDir === "." ? ref : `${baseDir}/${ref}`);
  const entryName = entryHtml.split("/").pop() ?? entryHtml;

  const html = await Deno.readTextFile(entryHtml);
  await Deno.writeTextFile(`${deckDir}/index.html`, html);

  const refs = collectAssetRefs(html);
  const plan = planStaging(refs);
  if (plan.outside.length > 0) {
    fail(
      "these references leave the output directory and cannot be published:\n  " +
        plan.outside.join("\n  "),
    );
  }
  for (const dir of plan.directories) {
    if (!(await exists(fromBase(dir)))) {
      fail(`referenced directory is missing: ${fromBase(dir)}`);
    }
    await copyDir(fromBase(dir), `${deckDir}/${dir}`);
  }
  for (const file of plan.files) {
    if (file === entryName) {
      continue; // the entry document is already staged as index.html
    }
    if (!(await exists(fromBase(file)))) {
      fail(`referenced file is missing: ${fromBase(file)}`);
    }
    await Deno.copyFile(fromBase(file), `${deckDir}/${file}`);
  }

  // Top-level stylesheets can reference images and fonts the HTML scan
  // cannot see; stage one level of their url()/@import targets too.
  const cssRefs = new Set<string>();
  for (const file of plan.files) {
    if (file === entryName || !file.toLowerCase().endsWith(".css")) {
      continue;
    }
    for (const ref of collectCssRefs(await Deno.readTextFile(fromBase(file)))) {
      cssRefs.add(ref);
    }
  }
  const cssPlan = planStaging([...cssRefs]);
  if (cssPlan.outside.length > 0) {
    fail(
      "stylesheet references leave the output directory and cannot be published:\n  " +
        cssPlan.outside.join("\n  "),
    );
  }
  for (const dir of cssPlan.directories) {
    if (!plan.directories.includes(dir)) {
      if (!(await exists(fromBase(dir)))) {
        fail(`directory referenced from a stylesheet is missing: ${fromBase(dir)}`);
      }
      await copyDir(fromBase(dir), `${deckDir}/${dir}`);
    }
  }
  for (const file of cssPlan.files) {
    if (!plan.files.includes(file) && (await exists(fromBase(file)))) {
      await Deno.copyFile(fromBase(file), `${deckDir}/${file}`);
    }
  }

  // Every scanned reference must resolve inside the staged tree.
  const missing: string[] = [];
  for (const ref of [...refs, ...cssRefs]) {
    if (ref !== entryName && !(await exists(`${deckDir}/${ref}`))) {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    fail(`staged deck is missing referenced assets:\n  ${missing.join("\n  ")}`);
  }

  // Configured artifacts (e.g. a slides PDF) are staged beside the deck.
  // Sources are project-root relative; the publisher never builds them.
  for (const artifact of artifacts) {
    if (!(await exists(artifact.source))) {
      fail(
        `artifact "${artifact.name}" source does not exist: ${artifact.source}\n` +
          "(the publisher stages existing files; build the PDF before publishing)",
      );
    }
    const targetPath = `${deckDir}/${artifact.target}`;
    const parent = targetPath.slice(0, targetPath.lastIndexOf("/"));
    await Deno.mkdir(parent, { recursive: true });
    await Deno.copyFile(artifact.source, targetPath);
    console.log(`artifact ${artifact.name}: ${publicUrl(target)}${artifact.target}`);
  }

  // Served for every asset beneath the deck's routes; see headersFileContent.
  await Deno.writeTextFile(`${publicDir}/_headers`, headersFileContent());

  console.log(
    `staged ${plan.directories.length + cssPlan.directories.length} directories, ` +
      `${plan.files.length + 1} files, and ${artifacts.length} artifacts under ${target.slug}/`,
  );
  return publicDir;
}

async function deployDeck(opts: Options, target: CloudflareTarget, stagingDir: string) {
  await Deno.writeTextFile(`${stagingDir}/worker.js`, deckWorkerScript(target.slug));
  await Deno.writeTextFile(
    `${stagingDir}/wrangler.json`,
    `${JSON.stringify(deckWranglerConfig(target), null, 2)}\n`,
  );

  const contentHash = await hashStagedContent(`${stagingDir}/public`);
  const state = await readState();
  const known = state.decks[target.slug];
  const name = workerName(target.slug);

  const wrangler = await resolveWrangler();
  const alreadyDeployed = await workerExists(wrangler, name);

  // Only --adopt authorizes taking over an unrecorded Worker; --force must
  // not silently clobber a Worker this project never published.
  if (alreadyDeployed && known === undefined && !opts.adopt) {
    fail(
      `a Worker named "${name}" already exists but this project has no record of it. ` +
        "Rerun with --adopt to take it over, or pick another slug with --slug.",
    );
  }
  // Skip only when content AND routing are unchanged: a host or zone edit
  // must redeploy even if the staged bytes are identical.
  const unchanged =
    alreadyDeployed &&
    known !== undefined &&
    known.contentHash === contentHash &&
    known.host === target.host &&
    known.zone === target.zone;
  if (unchanged && !opts.force) {
    // A deployment whose verification never succeeded (e.g. DNS was still
    // propagating) is retried here without redeploying unchanged content.
    if (known.verification === "pending" && !opts.noVerify) {
      console.log(`content unchanged; retrying the pending verification of "${target.slug}"`);
      if (!(await verifyPublished(verifyUrl(target)))) {
        fail(
          `published deck is still not reachable at ${publicUrl(target)} ` +
            "(DNS may still be propagating; rerun `make publish` later to retry)",
        );
      }
      known.verification = "ok";
      await writeState(state);
    } else {
      console.log(`content unchanged since the last publish of "${target.slug}"; skipping deploy`);
      console.log("(use --force to deploy anyway)");
    }
    console.log(`\npublished at: ${publicUrl(target)}`);
    return;
  }

  console.log(`deploying Worker "${name}" for ${publicUrl(target)}`);
  const deploy = await run([...wrangler, "deploy", "--config", `${stagingDir}/wrangler.json`]);
  if (deploy.code !== 0) {
    fail(`wrangler deploy failed with exit code ${deploy.code}`);
  }

  // Record the deployment immediately so a failed verification never strands
  // a Worker this project owns behind the --adopt guard; verification is
  // finalized (or retried on the next run) via the verification field.
  const record: DeckRecord = {
    worker: name,
    host: target.host,
    zone: target.zone,
    contentHash,
    published: new Date().toISOString(),
    verification: opts.noVerify ? "skipped" : "pending",
  };
  state.decks[target.slug] = record;
  await writeState(state);

  if (!opts.noVerify) {
    if (!(await verifyPublished(verifyUrl(target)))) {
      fail(
        `published deck did not become reachable at ${publicUrl(target)}\n` +
          "The deployment itself succeeded and was recorded; once DNS has " +
          "propagated, rerun `make publish` to retry verification without redeploying.",
      );
    }
    record.verification = "ok";
    await writeState(state);
  }
  console.log(`\npublished at: ${publicUrl(target)}`);
}

async function unpublish(opts: Options): Promise<void> {
  const incompatible = [
    opts.input !== undefined ? "--input" : undefined,
    opts.host !== undefined ? "--host" : undefined,
    opts.zone !== undefined ? "--zone" : undefined,
    opts.stageOnly ? "--stage-only" : undefined,
    opts.stagingDir !== undefined ? "--staging-dir" : undefined,
    opts.keepStaging ? "--keep-staging" : undefined,
    opts.noVerify ? "--no-verify" : undefined,
    opts.force ? "--force" : undefined,
    opts.adopt ? "--adopt" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (incompatible.length > 0) {
    fail(`--unpublish accepts only --slug; remove ${incompatible.join(", ")}`);
  }

  const state = await readState();
  const recordedSlugs = Object.keys(state.decks).sort();
  let slug: string;
  if (opts.slug !== undefined) {
    const slugError = validateSlug(opts.slug);
    if (slugError !== null) {
      fail(slugError);
    }
    slug = opts.slug;
  } else {
    if (recordedSlugs.length === 0) {
      fail(`no published talks are recorded in ${STATE_FILE}`);
    }
    if (recordedSlugs.length > 1) {
      fail(
        `several published talks are recorded (${recordedSlugs.join(", ")}); ` +
          "pass --slug to choose one",
      );
    }
    slug = recordedSlugs[0];
  }

  const known = state.decks[slug];
  if (known === undefined) {
    fail(
      `no published talk with slug "${slug}" is recorded in ${STATE_FILE}; ` +
        "refusing to delete an unowned Worker",
    );
  }
  const expectedWorker = workerName(slug);
  if (known.worker !== expectedWorker || typeof known.host !== "string") {
    fail(
      `invalid publish record for slug "${slug}"; expected Worker ` +
        `"${expectedWorker}"; refusing to delete it`,
    );
  }

  const wrangler = await resolveWrangler();
  if (await workerExists(wrangler, expectedWorker)) {
    console.log(`unpublishing https://${known.host}/${slug}/ (Worker "${expectedWorker}")`);
    const deletion = await run([...wrangler, "delete", "--name", expectedWorker], {
      stdin: "inherit",
    });
    if (deletion.code !== 0) {
      fail(`wrangler delete failed with exit code ${deletion.code}; local record kept`);
    }
    // Wrangler exits successfully when its confirmation is declined. Confirm
    // the Worker is gone before dropping the ownership record.
    if (await workerExists(wrangler, expectedWorker)) {
      fail(`Worker "${expectedWorker}" still exists; local record kept`);
    }
  } else {
    console.log(`Worker "${expectedWorker}" is already absent; removing its stale local record`);
  }

  delete state.decks[slug];
  await writeState(state);
  console.log(`unpublished: https://${known.host}/${slug}/`);
}

async function bootstrapGateway(opts: Options): Promise<void> {
  let host = opts.host;
  let zone = opts.zone;
  if (host === undefined) {
    const qmds = await listQmdFiles();
    const input = resolveInput(qmds, opts.input);
    if (typeof input === "string" && (await exists(input))) {
      const { cloudflareMeta } = await inspectDeck(input);
      const target = resolveTarget({
        metadata: cloudflareMeta,
        cliSlug: "bootstrap",
        projectName: "bootstrap",
      });
      if ("error" in target) {
        fail(target.error);
      }
      host = target.host;
      zone = zone ?? target.zone;
    } else {
      host = DEFAULT_HOST;
    }
  }
  if (zone === undefined) {
    const derived = deriveZone(host);
    if (derived === null) {
      fail(`cannot derive a zone from "${host}": pass --zone`);
    }
    zone = derived;
  }

  const stagingDir = await Deno.makeTempDir({ prefix: "altmejd-gateway-" });
  try {
    await Deno.writeTextFile(`${stagingDir}/worker.js`, gatewayWorkerScript());
    await Deno.writeTextFile(
      `${stagingDir}/wrangler.json`,
      `${JSON.stringify(gatewayWranglerConfig(host, zone), null, 2)}\n`,
    );
    if (opts.stageOnly) {
      console.log(`stage-only: gateway staged in ${stagingDir}, nothing deployed`);
      opts.keepStaging = true;
      return;
    }
    console.log(`deploying gateway Worker for https://${host}/ (zone ${zone})`);
    const wrangler = await resolveWrangler();
    const deploy = await run([...wrangler, "deploy", "--config", `${stagingDir}/wrangler.json`]);
    if (deploy.code !== 0) {
      fail(`wrangler deploy failed with exit code ${deploy.code}`);
    }
    console.log(`gateway deployed: https://${host}/ now falls back to redirects and 404s`);
    // The Custom Domain's DNS record can lag behind the deploy; report
    // readiness separately so a slow resolver is not mistaken for failure.
    const attempts = envNumber("ALTMEJD_SLIDES_VERIFY_ATTEMPTS", 6);
    const delayMs = envNumber("ALTMEJD_SLIDES_VERIFY_DELAY_MS", 5000);
    let reachable = false;
    for (let attempt = 1; attempt <= attempts && !reachable; attempt++) {
      try {
        await fetch(`https://${host}/`, { redirect: "manual" });
        reachable = true; // any HTTP answer means DNS and the domain resolve
      } catch {
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    if (reachable) {
      console.log(`custom domain answers: https://${host}/ is live`);
    } else {
      console.log(
        `custom domain not reachable yet: the DNS record for ${host} is created ` +
          "but may take minutes to propagate; publishing works meanwhile and " +
          "verification can be retried with `make publish`.",
      );
    }
  } finally {
    if (!opts.keepStaging) {
      await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
    }
  }
}

async function publish(opts: Options): Promise<void> {
  const qmds = await listQmdFiles();
  const input = resolveInput(qmds, opts.input);
  if (typeof input !== "string") {
    fail(input.error);
  }
  if (!(await exists(input))) {
    fail(`input does not exist: ${input}`);
  }

  const { outputFile, outputDir, cloudflareMeta } = await inspectDeck(input);
  const metadata = {
    ...cloudflareMeta,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.zone !== undefined ? { zone: opts.zone } : {}),
  };
  const target = resolveTarget({
    metadata,
    cliSlug: opts.slug,
    projectName: await projectName(),
  });
  if ("error" in target) {
    fail(target.error);
  }
  const artifacts = resolveArtifacts(metadata.artifacts);
  if (!Array.isArray(artifacts)) {
    fail(artifacts.error);
  }
  console.log(`publishing ${input} to ${publicUrl(target)}`);

  const render = await run(["quarto", "render", input]);
  if (render.code !== 0) {
    fail(`quarto render ${input} failed with exit code ${render.code}`);
  }
  const entryHtml = outputDir === "." ? outputFile : `${outputDir}/${outputFile}`;
  if (!(await exists(entryHtml))) {
    fail(`render did not produce ${entryHtml}`);
  }

  const stagingDir = opts.stagingDir ?? (await Deno.makeTempDir({ prefix: "altmejd-publish-" }));
  await Deno.mkdir(stagingDir, { recursive: true });
  try {
    await stageDeck(entryHtml, outputDir, target, artifacts, stagingDir);
    if (opts.stageOnly) {
      console.log(`stage-only: deck staged in ${stagingDir}, nothing deployed`);
      opts.keepStaging = true;
      return;
    }
    await deployDeck(opts, target, stagingDir);
  } finally {
    if (!opts.keepStaging && opts.stagingDir === undefined) {
      await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
    }
  }
}

const opts = parseArgs(Deno.args);
if (opts.bootstrapGateway) {
  await bootstrapGateway(opts);
} else if (opts.unpublish) {
  await unpublish(opts);
} else {
  await publish(opts);
}
