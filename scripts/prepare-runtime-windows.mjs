#!/usr/bin/env node
/**
 * Assemble `runtime/` on Windows: node, PostgreSQL 17 with pgvector, ffmpeg, the
 * patched Immich server, its web UI, the CLIP service and the core plugin.
 *
 *   node scripts/prepare-runtime-windows.mjs
 *   node scripts/prepare-runtime-windows.mjs --skip-ml --skip-models
 *   node scripts/prepare-runtime-windows.mjs --runtime .runtime-test --skip-server
 *
 * This is the counterpart of `prepare-runtime-macos.mjs`, and produces the same
 * layout, because `src-tauri/src/runtime.rs` starts whatever it finds at those
 * paths and knows nothing about the platform underneath:
 *
 *   runtime/node/node.exe
 *   runtime/pg/bin/postgres.exe            PostgreSQL 17, pgvector installed
 *   runtime/ffmpeg/bin/{ffmpeg,ffprobe}.exe
 *   runtime/immich/server/dist/main.js     the server, deployed with its node_modules
 *   runtime/www/index.html                 Immich's web UI
 *   runtime/plugins/immich-plugin-core/    the workflow plugin wasm
 *   runtime/ml/{index.mjs,models/}         CLIP service for smart search
 *
 * Three things differ from macOS and each one is a way this can fail:
 *
 * 1. **The Postgres archive has no pgvector.** Theseus's Windows build ships the
 *    PostgreSQL tree and nothing else, so pgvector is compiled here with MSVC
 *    against that tree's headers (`include/server`) and import library
 *    (`lib/postgres.lib`). Without it, Immich's first migration fails on
 *    `CREATE EXTENSION vector` and the database sits on "Starting" forever.
 *    This needs Visual Studio Build Tools with the C++ workload, which is the
 *    same thing the Rust MSVC toolchain needs.
 *
 * 2. **There is no Homebrew to fall back on.** Every binary is a pinned download
 *    with a published checksum where the project publishes one, extracted with
 *    Windows' own bsdtar: Git Bash's GNU tar reads `C:\…` as a remote host.
 *
 * 3. **The downloads float at their edges.** node is pinned to a major, ffmpeg
 *    comes from gyan.dev's "release" build (which moves: it was 8.1.1 when this
 *    runtime was first assembled, 9.0.2 a day later), and the two versions are
 *    printed at the end so a release can record what it shipped.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { IMMICH_REF, PATCH_FILE } from "./immich-ref.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) {
    return inline.slice(name.length + 3);
  }
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--")) {
    return argv[at + 1];
  }
  return fallback;
};

// A misspelled option that is silently ignored is how a scratch build lands on
// top of the runtime the app runs from. Every option has to be understood.
const KNOWN = new Set([
  "dry-run", "skip-server", "skip-web", "skip-plugin", "skip-ml", "skip-models",
  "arch", "immich-ref", "node-major", "node-version", "pg-release", "pgvector-version",
  "ffmpeg-zip", "runtime", "www-source",
]);
for (const arg of argv) {
  if (!arg.startsWith("--")) {
    continue;
  }
  const name = arg.slice(2).split("=")[0];
  if (!KNOWN.has(name)) {
    console.error(`\n\x1b[31m✗ unknown option --${name}\x1b[0m\n  Known: ${[...KNOWN].map((k) => `--${k}`).join(", ")}\n`);
    process.exit(1);
  }
}

const dryRun = flag("dry-run");
const skipServer = flag("skip-server");
const skipWeb = flag("skip-web");
const skipPlugin = flag("skip-plugin");
const skipMl = flag("skip-ml");
const skipModels = flag("skip-models");
const arch = option("arch", process.arch === "arm64" ? "arm64" : "x64");
const immichRef = option("immich-ref", IMMICH_REF);
const nodeMajor = option("node-major", "v24.");
const nodeVersion = option("node-version", null);
const pgRelease = option("pg-release", "17.7.1");
const pgvectorVersion = option("pgvector-version", "0.8.7");
const ffmpegZip = option(
  "ffmpeg-zip",
  "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
);

const runtime = path.resolve(root, option("runtime", "runtime"));
/// How the target is named in messages. A scratch build that reports `runtime/`
/// while writing somewhere else is how the wrong tree gets trusted.
const relRuntime = () => path.relative(root, runtime).replace(/\\/g, "/") || "runtime";
const cache = path.join(root, ".win-build");
const work = path.join(cache, "immich");
const patchFile = path.join(root, PATCH_FILE);

const say = (text) => console.log(`\n\x1b[1m▸ ${text}\x1b[0m`);
const note = (text) => console.log(`  ${text}`);
function die(text) {
  console.error(`\n\x1b[31m✗ ${text}\x1b[0m`);
  process.exit(1);
}

// ── shell ────────────────────────────────────────────────────────────────────
//
// Windows only starts `.cmd` and `.bat` through cmd.exe, and pnpm, npm and
// corepack are all shims of that kind. Going through `cmd /c` with every
// argument quoted is what makes `corepack pnpm …` work without a shell string.

const win = process.platform === "win32";
const quote = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);

function sh(command, args, cwd = root, env = process.env, { capture = false } = {}) {
  if (dryRun) {
    note(`would run: ${command} ${args.join(" ")}` + (cwd === root ? "" : `  (in ${path.relative(root, cwd)})`));
    return "";
  }
  const line = [command, ...args].map(quote).join(" ");
  const result = win
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], {
        cwd,
        env,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        encoding: "utf8",
      })
    : spawnSync(command, args, {
        cwd,
        env,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        encoding: "utf8",
      });
  if (result.error) {
    die(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return capture ? String(result.stdout ?? "").trim() : "";
}

function has(command) {
  try {
    execFileSync(win ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── downloads and archives ───────────────────────────────────────────────────

async function download(url, destination) {
  if (dryRun) {
    note(`would download ${url}`);
    note(`            → ${path.relative(root, destination)}`);
    return;
  }
  if (existsSync(destination) && statSync(destination).size > 0) {
    note(`cached ${path.basename(destination)}`);
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  note(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    die(`download failed (${response.status}) for ${url}`);
  }
  const partial = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, destination);
  note(`${(statSync(destination).size / 1e6).toFixed(1)} MB`);
}

/// Theseus publishes `<asset>.sha256`; checking it is the difference between a
/// truncated archive and a Postgres that fails `initdb` halfway through.
async function verifyPublishedChecksum(url, file) {
  if (dryRun) {
    return;
  }
  const response = await fetch(`${url}.sha256`, { redirect: "follow" });
  if (!response.ok) {
    die(`could not fetch the checksum for ${path.basename(file)} (${response.status})`);
  }
  const want = (await response.text()).trim().split(/\s+/)[0].toLowerCase();
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!want || want !== got) {
    die(`checksum mismatch for ${path.basename(file)}\n  expected ${want}\n  got      ${got}`);
  }
  note(`sha256 ok (${got.slice(0, 12)}…)`);
}

/// Windows' bsdtar, by absolute path. Git Bash's GNU tar is first on PATH and
/// refuses `C:\…` ("Cannot connect to C:"), which reads as a network error.
const tar = win
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

function extract(archive, destination, { strip = false } = {}) {
  if (dryRun) {
    note(`would extract ${path.basename(archive)} into ${path.relative(root, destination)}`);
    return;
  }
  mkdirSync(destination, { recursive: true });
  sh(tar, ["-xf", archive, "-C", destination]);
  if (strip) {
    // Every one of these archives wraps its contents in a single top folder.
    const entries = readdirSync(destination);
    if (entries.length !== 1) {
      die(`${path.basename(archive)} did not unpack into a single folder (${entries.join(", ")})`);
    }
    const inner = path.join(destination, entries[0]);
    for (const name of readdirSync(inner)) {
      renameSync(path.join(inner, name), path.join(destination, name));
    }
    rmSync(inner, { recursive: true, force: true });
  }
}

function fresh(dir) {
  if (dryRun) {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

// ── node ─────────────────────────────────────────────────────────────────────
async function fetchNode() {
  say(`node (win32-${arch})`);
  let version = nodeVersion;
  if (!version) {
    if (dryRun) {
      note(`would resolve the newest ${nodeMajor.replace(/\.$/, "")} from nodejs.org/index.json`);
      note(`would download node-<version>-win-${arch}.zip and keep node.exe`);
      return "";
    }
    const index = await fetch("https://nodejs.org/dist/index.json").then((response) => {
      if (!response.ok) {
        die(`could not reach nodejs.org (${response.status})`);
      }
      return response.json();
    });
    version = (index.find((entry) => entry.version.startsWith(nodeMajor)) ?? index[0]).version;
  }

  const zipName = `node-${version}-win-${arch}.zip`;
  const url = `https://nodejs.org/dist/${version}/${zipName}`;
  const saved = path.join(cache, zipName);
  await download(url, saved);

  if (dryRun) {
    note(`would extract ${zipName} and keep node.exe`);
    return version;
  }

  const staging = path.join(cache, "node-stage");
  const unpacked = path.join(staging, "node.exe");
  if (!existsSync(unpacked)) {
    rmSync(staging, { recursive: true, force: true });
    extract(saved, staging, { strip: true });
    if (!existsSync(unpacked)) {
      die(`${zipName} did not contain node.exe`);
    }
  }

  fresh(path.join(runtime, "node"));
  // Only the interpreter ships: npm and corepack are scripts, and the app never
  // runs them. `fetchServer` puts this directory first on PATH for the build.
  copyFileSyncSafe(unpacked, path.join(runtime, "node", "node.exe"));
  const reported = sh(path.join(runtime, "node", "node.exe"), ["--version"], root, process.env, { capture: true });
  note(`${version} → ${relRuntime()}/node/node.exe (${reported})`);
  return reported;
}

function copyFileSyncSafe(from, to) {
  if (dryRun) {
    note(`would copy ${path.basename(from)} → ${path.relative(root, to)}`);
    return;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// ── postgres ─────────────────────────────────────────────────────────────────
function vcvars64() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const candidates = [];
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ["-all", "-products", "*", "-property", "installationPath"], {
      encoding: "utf8",
    }).stdout;
    for (const line of String(found ?? "").split(/\r?\n/)) {
      if (line.trim()) {
        candidates.push(path.join(line.trim(), "VC", "Auxiliary", "Build", "vcvars64.bat"));
      }
    }
  }
  for (const edition of ["Community", "BuildTools", "Professional", "Enterprise"]) {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (base) {
        candidates.push(path.join(base, "Microsoft Visual Studio", "2022", edition, "VC", "Auxiliary", "Build", "vcvars64.bat"));
      }
    }
  }
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) {
    die(
      "Visual Studio's C++ build tools are missing, so pgvector cannot be compiled.\n" +
        "  Install Visual Studio Build Tools with the 'Desktop development with C++' workload\n" +
        "  (the same one the Rust MSVC toolchain needs), then run this again.\n" +
        "  Expected to find: …\\VC\\Auxiliary\\Build\\vcvars64.bat",
    );
  }
  return hit;
}

async function fetchPostgres() {
  say(`PostgreSQL ${pgRelease} + pgvector ${pgvectorVersion}`);
  const asset = `postgresql-${pgRelease}-${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.zip`;
  const url = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${pgRelease}/${asset}`;
  const saved = path.join(cache, asset);
  await download(url, saved);
  if (!dryRun) {
    await verifyPublishedChecksum(url, saved);
  }

  const target = path.join(runtime, "pg");
  if (dryRun) {
    note(`would extract ${asset} into ${path.relative(root, target)}`);
  } else {
    const staging = path.join(cache, "pg-stage");
    rmSync(staging, { recursive: true, force: true });
    extract(saved, staging, { strip: true });
    fresh(target);
    for (const name of readdirSync(staging)) {
      renameSync(path.join(staging, name), path.join(target, name));
    }
    if (!existsSync(path.join(target, "bin", "postgres.exe"))) {
      die(`${asset} did not contain bin/postgres.exe`);
    }
    note(`${sh(path.join(target, "bin", "postgres.exe"), ["--version"], root, process.env, { capture: true })}`);
  }

  await buildPgvector(target);
}

/// pgvector is not in any Windows binary distribution, so it is compiled from
/// source against the Postgres tree just unpacked. `Makefile.win` is written for
/// exactly this: it takes `PGROOT`, compiles against `include/server` and
/// `lib/postgres.lib`, and installs into `lib` and `share/extension`.
///
/// The build runs through `vcvars64.bat` in a throwaway batch file because nmake
/// only exists inside a Developer Command Prompt's environment.
async function buildPgvector(target) {
  const srcZip = path.join(cache, `pgvector-${pgvectorVersion}.zip`);
  await download(`https://github.com/pgvector/pgvector/archive/refs/tags/v${pgvectorVersion}.zip`, srcZip);

  if (dryRun) {
    note(`would compile pgvector ${pgvectorVersion} with nmake /F Makefile.win (PGROOT=runtime/pg)`);
    return;
  }

  const srcDir = path.join(cache, `pgvector-${pgvectorVersion}`);
  if (!existsSync(path.join(srcDir, "Makefile.win"))) {
    rmSync(srcDir, { recursive: true, force: true });
    const staging = path.join(cache, "pgvector-stage");
    rmSync(staging, { recursive: true, force: true });
    extract(srcZip, staging, { strip: true });
    renameSync(staging, srcDir);
  }

  const script = path.join(cache, "build-pgvector.bat");
  // `install` copies vector.dll into $(PGROOT)\lib and the control and sql files
  // into $(PGROOT)\share\extension, which is the layout the server loads from.
  writeFileSync(
    script,
    [
      "@echo off",
      "setlocal",
      `call ${quote(vcvars64())} >nul || exit /b 1`,
      `set "PGROOT=${target}"`,
      `cd /d ${quote(srcDir)} || exit /b 2`,
      "nmake /nologo /F Makefile.win >nul || exit /b 3",
      "nmake /nologo /F Makefile.win install >nul || exit /b 4",
      "exit /b 0",
      "",
    ].join("\r\n"),
  );

  // Captured rather than inherited: Visual Studio's `vcvars64.bat` prints its own
  // chatter, including a "'vswhere.exe' is not recognized" line on this machine,
  // even when it sets the environment correctly. The exit code is the signal, and
  // the output is worth showing only when it fails.
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", quote(script)], {
    cwd: cache,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    die(
      `pgvector failed to build (exit ${result.status}).\n` +
        "--- nmake ---\n" +
        `${(result.stdout ?? "") + (result.stderr ?? "")}`.trim().split("\n").slice(-25).join("\n"),
    );
  }

  const control = path.join(target, "share", "extension", "vector.control");
  const dll = path.join(target, "lib", "vector.dll");
  if (!existsSync(control) || !existsSync(dll)) {
    die(
      "pgvector compiled but did not install into the Postgres tree.\n" +
        `  Looked for ${path.relative(root, dll)} and ${path.relative(root, control)}.\n` +
        "  Run the batch file by hand to see nmake's output:\n" +
        `    ${path.relative(root, script)}`,
    );
  }
  const declared = /default_version\s*=\s*'([^']+)'/.exec(readFileSync(control, "utf8"))?.[1] ?? "?";
  if (declared !== pgvectorVersion) {
    note(`warning: vector.control declares ${declared}, expected ${pgvectorVersion}`);
  }
  note(`${relRuntime()}/pg with pgvector ${declared} (${(statSync(dll).size / 1e3).toFixed(0)} KB dll)`);
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────
async function fetchFfmpeg() {
  say("ffmpeg + ffprobe");
  const zipName = path.basename(new URL(ffmpegZip).pathname);
  const saved = path.join(cache, zipName);
  await download(ffmpegZip, saved);
  if (dryRun) {
    note("would extract bin/ffmpeg.exe and bin/ffprobe.exe into runtime/ffmpeg/bin");
    return;
  }

  const staging = path.join(cache, "ffmpeg-stage");
  rmSync(staging, { recursive: true, force: true });
  extract(saved, staging, { strip: true });

  const binDir = path.join(staging, "bin");
  if (!existsSync(binDir)) {
    die(`${zipName} did not contain bin/ (gyan's builds do; a different archive may not)`);
  }
  fresh(path.join(runtime, "ffmpeg", "bin"));
  for (const name of ["ffmpeg.exe", "ffprobe.exe"]) {
    const from = path.join(binDir, name);
    if (!existsSync(from)) {
      die(`${zipName} did not contain bin/${name}`);
    }
    copyFileSyncSafe(from, path.join(runtime, "ffmpeg", "bin", name));
  }
  // gyan's "release" build moves; printing it is how a release records the
  // version it actually shipped, which the licence notice needs.
  note(sh(path.join(runtime, "ffmpeg", "bin", "ffprobe.exe"), ["-version"], root, process.env, { capture: true }).split("\n")[0]);
}

// ── immich server ────────────────────────────────────────────────────────────
/// The build must run on the Node the runtime ships. `pnpm` and `npm` shims
/// resolve `node` from PATH, so putting `runtime/node` first is enough, and it
/// gives `pnpm deploy`'s native rebuilds (bcrypt, sharp) the ABI the app loads.
function runtimeNodeEnv() {
  if (dryRun) {
    return process.env;
  }
  const bin = path.join(runtime, "node");
  if (!existsSync(path.join(bin, "node.exe"))) {
    return process.env;
  }
  return { ...process.env, PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
}

function pnpmCommand() {
  if (has("pnpm")) {
    return { command: "pnpm", prefix: [] };
  }
  if (has("corepack")) {
    return { command: "corepack", prefix: ["pnpm"] };
  }
  die("pnpm is required. Install it with `npm i -g pnpm@11`, or run `corepack enable`.");
}

function pnpm(args, cwd) {
  const { command, prefix } = pnpmCommand();
  return sh(command, [...prefix, ...args], cwd, runtimeNodeEnv());
}

async function fetchServer() {
  say(`Immich server ${immichRef} + our patches`);
  if (!existsSync(patchFile)) {
    die(`the patch is missing: ${patchFile}`);
  }
  if (dryRun) {
    note(`would clone https://github.com/immich-app/immich.git (${immichRef}) into .win-build/immich`);
    note("would git apply the desktop patch");
    note("would pnpm install --no-frozen-lockfile, pnpm --filter immich... build, pnpm --filter immich deploy --prod --legacy");
    return;
  }

  if (!existsSync(path.join(work, ".git"))) {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    sh("git", ["clone", "--depth", "1", "--branch", immichRef, "https://github.com/immich-app/immich.git", work]);
  } else {
    note("reusing .win-build/immich");
  }

  try {
    sh("git", ["apply", "--check", patchFile], work);
    sh("git", ["apply", patchFile], work);
    note("applied the desktop patch");
  } catch {
    const already = sh("git", ["diff", "--stat", "--", "server/src"], work, process.env, { capture: true });
    if (!already) {
      die(
        `the patch does not apply to ${immichRef}.\n` +
          `  Upstream moved. Re-apply it by hand and update ${path.relative(root, patchFile)}.`,
      );
    }
    note("patch already applied");
  }

  // The patch touches no dependency, so the lockfile is regenerated rather than
  // patched; `--frozen-lockfile` would fail on the Git-versioned one.
  pnpm(["install", "--no-frozen-lockfile"], work);
  // `immich...` builds the server and the workspace packages it imports.
  pnpm(["--filter", "immich...", "build"], work);

  const serverDir = path.join(runtime, "immich", "server");
  fresh(serverDir);
  try {
    pnpm(["--filter", "immich", "deploy", "--prod", "--legacy", serverDir], work);
  } catch {
    die(
      "pnpm deploy failed, so there is no self-contained server to ship.\n" +
        "  Run it by hand in .win-build/immich to see why:\n" +
        `    pnpm --filter immich deploy --prod --legacy ${serverDir}\n` +
        "  A deploy is what turns pnpm's linked store into real files; copying\n" +
        "  node_modules instead leaves links that break as soon as the app moves.",
    );
  }

  for (const entry of ["dist", "bin", "helmet.json", "package.json"]) {
    const from = path.join(work, "server", entry);
    const to = path.join(serverDir, entry);
    if (existsSync(from) && !existsSync(to)) {
      cpRecursive(from, to);
    }
  }
  if (!existsSync(path.join(serverDir, "dist", "main.js"))) {
    die(`the server build produced no dist/main.js in ${serverDir}`);
  }
  note(`${relRuntime()}/immich/server (dist + deployed node_modules)`);
}

function cpRecursive(from, to) {
  if (dryRun) {
    note(`would copy ${path.relative(root, from)} → ${path.relative(root, to)}`);
    return;
  }
  cpSync(from, to, { recursive: true });
}

// ── core plugin ──────────────────────────────────────────────────────────────
/// The plugin build already exists as its own script, because it has to be
/// runnable on its own when only the plugin changes. Its toolchain downloads and
/// checksum checks live there; this just calls it against the same checkout.
function fetchCorePlugin() {
  say("Immich core plugin (workflow templates)");
  if (dryRun) {
    note("would run scripts/build-core-plugin-windows.mjs against .win-build/immich");
    note("  (extism-js and binaryen are fetched and checksum-checked there)");
    return;
  }
  const pkg = path.join(work, "packages", "plugin-core");
  if (!existsSync(path.join(pkg, "manifest.json"))) {
    die(
      `the plugin source is missing at ${path.relative(root, pkg)}.\n` +
        `  It ships in the ${immichRef} checkout fetchServer makes; run without --skip-server.`,
    );
  }
  sh(
    process.execPath,
    [path.join(here, "build-core-plugin-windows.mjs"), "--checkout", work, "--runtime", runtime],
    root,
    process.env,
  );
  const manifest = path.join(runtime, "plugins", "immich-plugin-core", "manifest.json");
  if (!existsSync(manifest)) {
    die(`the plugin build left no manifest at ${path.relative(root, manifest)}`);
  }
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  note(`${parsed.name}@${parsed.version}, ${parsed.methods?.length ?? 0} methods`);
}

// ── web ui ───────────────────────────────────────────────────────────────────
function fetchWeb() {
  say("Immich web UI");
  const prebuilt = option("www-source", path.join(root, "prebuilt", "www"));
  const target = path.join(runtime, "www");
  if (existsSync(path.join(prebuilt, "index.html"))) {
    fresh(target);
    cpRecursive(prebuilt, target);
    note(`copied prebuilt/www → runtime/www (${path.relative(root, prebuilt)})`);
    return;
  }
  if (dryRun) {
    note(`would run pnpm --filter web build in .win-build/immich and copy web/build → runtime/www`);
    return;
  }
  if (existsSync(path.join(target, "index.html"))) {
    note("runtime/www already holds a build — reusing it");
    return;
  }
  if (!existsSync(path.join(work, "web"))) {
    die("the web source is missing; run without --skip-server first");
  }
  pnpm(["--filter", "web", "build"], work);
  const build = path.join(work, "web", "build");
  if (!existsSync(path.join(build, "index.html"))) {
    die(`the web build produced no index.html in ${build}`);
  }
  fresh(target);
  cpRecursive(build, target);
  note(`${relRuntime()}/www built from source`);
}

// ── machine learning ─────────────────────────────────────────────────────────
async function fetchMachineLearning() {
  if (skipMl) {
    say("machine learning — skipped");
    note("the app treats a missing ML service as 'not installed' and does not queue its jobs");
    return;
  }
  say("CLIP service");
  const target = path.join(runtime, "ml");
  if (dryRun) {
    note("would copy ml/ and npm install --omit=dev (sharp + onnxruntime for win32)");
  } else {
    fresh(target);
    for (const file of ["index.mjs", "package.json", "smoke.mjs", "fetch-models.mjs"]) {
      copyFileSyncSafe(path.join(root, "ml", file), path.join(target, file));
    }
    sh("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], target, runtimeNodeEnv());
  }

  if (skipModels) {
    note("models skipped — smart search stays off until ml/models exists");
    return;
  }
  if (dryRun) {
    note("would download CLIP ViT-B/32 (~149 MB) into ml/models");
    return;
  }
  const models = path.join(root, "ml", "models");
  if (!existsSync(path.join(models, "Xenova"))) {
    // `fetch-models.mjs` imports `@huggingface/transformers`, and the only copy
    // is the one just installed to runtime/ml, so it runs from there and writes
    // into ml/models through CLIP_MODEL_DIR for the next build to reuse.
    sh(process.execPath, ["fetch-models.mjs"], target, { ...runtimeNodeEnv(), CLIP_MODEL_DIR: models });
  }
  cpRecursive(models, path.join(target, "models"));
  note(`${relRuntime()}/ml/models`);
}

// ── go ───────────────────────────────────────────────────────────────────────
if (!win && !dryRun) {
  die(
    `this assembles a Windows runtime, and this machine is ${process.platform}.\n` +
      "  Run it on Windows. (--dry-run works anywhere, for reading the plan.)",
  );
}

console.log(`\nImmich Desktop — Windows runtime (${arch})${dryRun ? "  [dry run]" : ""}`);
console.log(`  target: ${path.relative(root, runtime) || runtime}\n`);

let nodeReported = "";
let plugins = "skipped";

if (dryRun) {
  mkdirSync(cache, { recursive: true });
} else {
  mkdirSync(cache, { recursive: true });
  mkdirSync(runtime, { recursive: true });
}

nodeReported = (await fetchNode()) ?? "";
await fetchPostgres();
await fetchFfmpeg();

if (skipServer) {
  say("Immich server — skipped");
  note("runtime/immich/server is not produced; the app will fail to start the server");
} else {
  await fetchServer();
}

if (skipPlugin) {
  say("core plugin — skipped");
} else if (skipServer) {
  say("core plugin — skipped (needs the checkout the server build makes)");
} else {
  fetchCorePlugin();
  plugins = "built";
}

if (skipWeb) {
  say("web UI — skipped");
} else {
  fetchWeb();
}

await fetchMachineLearning();

if (!dryRun) {
  say("done");
  note(`runtime assembled at ${path.relative(root, runtime) || runtime}`);
  note(`node ${nodeReported}, ffmpeg from ${new URL(ffmpegZip).host}, plugin ${plugins}`);
  note("next: npm install && npm run tauri build");
}
