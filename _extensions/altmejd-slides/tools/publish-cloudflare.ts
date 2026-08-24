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
  deckWorkerScript,
  deckWranglerConfig,
  deriveZone,
  gatewayWorkerScript,
  gatewayWranglerConfig,
  planStaging,
  publicUrl,
  resolveInput,
  resolveTarget,
  workerName,
} from "./publish/core.ts";

const STATE_FILE = ".altmejd-slides-publish.json";

interface Options {
  bootstrapGateway: boolean;
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
  return opts;
}

function fail(message: string): never {
  console.error(`publish-cloudflare: ${message}`);
  Deno.exit(1);
}

async function run(
  cmd: string[],
  opts: { capture?: boolean; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
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

async function commandExists(name: string): Promise<boolean> {
  const probe = await run([name, "--version"], { capture: true });
  return probe.code === 0;
}

// Pinned dependency story: an explicit override, a wrangler already on PATH,
// or a pinned major via bunx/npx. Wrangler 4 is the supported major.
async function resolveWrangler(): Promise<string[]> {
  const override = Deno.env.get("ALTMEJD_SLIDES_WRANGLER");
  if (override !== undefined && override.trim() !== "") {
    return override.trim().split(/\s+/);
  }
  if (await commandExists("wrangler")) {
    return ["wrangler"];
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
  return { outputFile, cloudflareMeta };
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
    if (entry.isDirectory) {
      await copyDir(source, destination);
    } else if (entry.isFile) {
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

interface PublishState {
  version: 1;
  decks: Record<string, { worker: string; host: string; contentHash: string; published: string }>;
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
  if (/not\s*found|does not exist|10007|workers\.api\.error/i.test(output)) {
    return false;
  }
  fail(
    `could not query Worker "${name}" (check wrangler login or CLOUDFLARE_API_TOKEN):\n` +
      output.trim(),
  );
}

async function verifyPublished(url: string): Promise<void> {
  const attempts = 6;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      const body = await response.text();
      if (response.ok && /reveal/i.test(body)) {
        console.log(`verified: ${url} serves the deck (HTTP ${response.status})`);
        return;
      }
      console.error(`attempt ${attempt}/${attempts}: HTTP ${response.status} from ${url}`);
    } catch (error) {
      console.error(`attempt ${attempt}/${attempts}: ${(error as Error).message}`);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  fail(`published deck did not become reachable at ${url}`);
}

async function stageDeck(
  outputFile: string,
  target: CloudflareTarget,
  stagingDir: string,
): Promise<string> {
  const publicDir = `${stagingDir}/public`;
  const deckDir = `${publicDir}/${target.slug}`;
  await Deno.mkdir(deckDir, { recursive: true });

  const html = await Deno.readTextFile(outputFile);
  await Deno.writeTextFile(`${deckDir}/index.html`, html);

  const refs = collectAssetRefs(html);
  const plan = planStaging(refs);
  if (plan.outside.length > 0) {
    fail(
      "these references leave the deck directory and cannot be published:\n  " +
        plan.outside.join("\n  "),
    );
  }
  for (const dir of plan.directories) {
    if (!(await exists(dir))) {
      fail(`referenced directory is missing: ${dir}`);
    }
    await copyDir(dir, `${deckDir}/${dir}`);
  }
  for (const file of plan.files) {
    if (file === outputFile) {
      continue; // the entry document is already staged as index.html
    }
    if (!(await exists(file))) {
      fail(`referenced file is missing: ${file}`);
    }
    await Deno.copyFile(file, `${deckDir}/${file}`);
  }

  // Every scanned reference must resolve inside the staged tree.
  const missing: string[] = [];
  for (const ref of refs) {
    if (ref !== outputFile && !(await exists(`${deckDir}/${ref}`))) {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    fail(`staged deck is missing referenced assets:\n  ${missing.join("\n  ")}`);
  }
  console.log(
    `staged ${plan.directories.length} directories and ${plan.files.length + 1} files ` +
      `under ${target.slug}/`,
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

  if (alreadyDeployed && known === undefined && !opts.adopt && !opts.force) {
    fail(
      `a Worker named "${name}" already exists but this project has no record of it. ` +
        "Rerun with --adopt to take it over, or pick another slug with --slug.",
    );
  }
  if (alreadyDeployed && known !== undefined && known.contentHash === contentHash && !opts.force) {
    console.log(`content unchanged since the last publish of "${target.slug}"; skipping deploy`);
    console.log(`(use --force to deploy anyway)\n\npublished at: ${publicUrl(target)}`);
    return;
  }

  console.log(`deploying Worker "${name}" for ${publicUrl(target)}`);
  const deploy = await run([...wrangler, "deploy", "--config", `${stagingDir}/wrangler.json`]);
  if (deploy.code !== 0) {
    fail(`wrangler deploy failed with exit code ${deploy.code}`);
  }

  state.decks[target.slug] = {
    worker: name,
    host: target.host,
    contentHash,
    published: new Date().toISOString(),
  };
  await writeState(state);

  if (!opts.noVerify) {
    await verifyPublished(publicUrl(target));
  }
  console.log(`\npublished at: ${publicUrl(target)}`);
}

async function bootstrapGateway(opts: Options): Promise<void> {
  let host = opts.host;
  let zone = opts.zone;
  if (host === undefined) {
    const qmds = await listQmdFiles();
    const input = resolveInput(qmds, opts.input);
    if (typeof input !== "string") {
      fail(`${input.error}\n(or pass --host directly to --bootstrap-gateway)`);
    }
    const { cloudflareMeta } = await inspectDeck(input);
    const target = resolveTarget({
      metadata: cloudflareMeta,
      cliSlug: "bootstrap",
      inputStem: input,
    });
    if ("error" in target) {
      fail(target.error);
    }
    host = target.host;
    zone = zone ?? target.zone;
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
    console.log(`deploying gateway Worker for https://${host}/ (zone ${zone})`);
    if (opts.stageOnly) {
      console.log(`stage-only: gateway staged in ${stagingDir}`);
      opts.keepStaging = true;
      return;
    }
    const wrangler = await resolveWrangler();
    const deploy = await run([...wrangler, "deploy", "--config", `${stagingDir}/wrangler.json`]);
    if (deploy.code !== 0) {
      fail(`wrangler deploy failed with exit code ${deploy.code}`);
    }
    console.log(`gateway ready: https://${host}/ now falls back to redirects and 404s`);
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

  const { outputFile, cloudflareMeta } = await inspectDeck(input);
  const stem = input.replace(/\.qmd$/, "");
  const metadata = {
    ...cloudflareMeta,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.zone !== undefined ? { zone: opts.zone } : {}),
  };
  const target = resolveTarget({ metadata, cliSlug: opts.slug, inputStem: stem });
  if ("error" in target) {
    fail(target.error);
  }
  console.log(`publishing ${input} to ${publicUrl(target)}`);

  const render = await run(["quarto", "render", input]);
  if (render.code !== 0) {
    fail(`quarto render ${input} failed with exit code ${render.code}`);
  }
  if (!(await exists(outputFile))) {
    fail(`render did not produce ${outputFile}`);
  }

  const stagingDir = opts.stagingDir ?? (await Deno.makeTempDir({ prefix: "altmejd-publish-" }));
  await Deno.mkdir(stagingDir, { recursive: true });
  try {
    await stageDeck(outputFile, target, stagingDir);
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
} else {
  await publish(opts);
}
