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
 * 1. **No Postgres distribution for Windows has both extensions Immich needs.**
 *    pgvector is not in any of them, so it is compiled here with MSVC against the
 *    tree's headers (`include/server`) and import library (`lib/postgres.lib`).
 *    `uuid-ossp` is in EnterpriseDB's build but not in Theseus's, and Immich's
 *    schema uses it, so the Postgres source is EDB's; without it every insert that
 *    defaults to `uuid_generate_v4()` fails. This needs Visual Studio Build Tools
 *    with the C++ workload, the same one the Rust MSVC toolchain needs.
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
  "arch", "immich-ref", "node-major", "node-version", "pg-zip", "pgvector-version",
  "ffmpeg-zip", "runtime",
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
/// EnterpriseDB's binaries, not Theseus's. Theseus ships 49 extensions and Immich
/// needs `uuid-ossp`, which Immich's schema uses for row identifiers: without it
/// every insert that defaults to `uuid_generate_v4()` fails with
/// `could not access file "$libdir/uuid-ossp"`, including the one that registers
/// the workflow plugin. EDB ships 60 extensions and the `postgres.lib` that
/// pgvector links against. EDB publishes SHA-256 values on its download page only,
/// so this archive cannot be checksum-verified the way the Theseus one was; the
/// version and the extension list are checked instead.
const pgZip = option(
  "pg-zip",
  "https://get.enterprisedb.com/postgresql/postgresql-17.7-1-windows-x64-binaries.zip",
);
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

function sh(command, args, cwd = root, env = process.env, { capture = false, allowFailure = false } = {}) {
  if (dryRun) {
    note(`would run: ${command} ${args.join(" ")}` + (cwd === root ? "" : `  (in ${path.relative(root, cwd)})`));
    return allowFailure ? { status: 0, stdout: "", stderr: "" } : "";
  }
  // On Windows, a bare name like `corepack` has to go through cmd so the PATH
  // lookup finds `corepack.cmd`, and cmd resolves it without quoting, which works
  // even when the shim lives under `C:\Program Files\nodejs`.
  //
  // An absolute path must not go through cmd: `cmd /s /c "C:\Program Files\…"`
  // strips the outer quotes and then reads `C:\Program` as the command, which is
  // the failure that broke the plugin step. Node passes an absolute path to
  // CreateProcess itself, quoting it correctly.
  const line = [command, ...args].map(quote).join(" ");
  const viaShell = win && !path.isAbsolute(command);
  const stdio = capture || allowFailure ? ["ignore", "pipe", "pipe"] : "inherit";
  const result = viaShell
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], { cwd, env, stdio, encoding: "utf8" })
    : spawnSync(command, args, { cwd, env, stdio, encoding: "utf8" });
  if (result.error) {
    die(`${command} could not be started: ${result.error.message}`);
  }
  if (allowFailure) {
    return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
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

  // Retried for the same reason as the macOS script: these are GitHub release
  // assets behind a redirect, and a dropped connection partway through is worth
  // another attempt rather than another whole run. A 4xx is not retried.
  const partial = `${destination}.part`;
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    note(
      attempt === 1
        ? `downloading ${url}`
        : `retrying ${url} (attempt ${attempt} of ${attempts})`,
    );
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        const error = new Error(`download failed (${response.status}) for ${url}`);
        Object.assign(error, { fatal: response.status < 500 });
        throw error;
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, destination);
      note(`${(statSync(destination).size / 1e6).toFixed(1)} MB`);
      return;
    } catch (error) {
      rmSync(partial, { force: true });
      if (error.fatal || attempt === attempts) {
        die(`${error.message} (attempt ${attempt} of ${attempts})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
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
  say("PostgreSQL 17 (EnterpriseDB binaries) + pgvector");
  if (arch !== "x64") {
    die(
      "EDB publishes Windows x64 binaries only." +
        `  --arch ${arch} has no Postgres archive to download; use x64.`,
    );
  }
  const zipName = path.basename(new URL(pgZip).pathname);
  const saved = path.join(cache, zipName);
  await download(pgZip, saved);

  const target = path.join(runtime, "pg");
  if (dryRun) {
    note(`would extract ${zipName} into .win-build/pg-stage`);
    note("would compile pgvector against it, drop pgAdmin/StackBuilder/doc/include, then move to runtime/pg");
    return;
  }

  const staging = path.join(cache, "pg-stage");
  rmSync(staging, { recursive: true, force: true });
  extract(saved, staging, { strip: true });
  if (!existsSync(path.join(staging, "bin", "postgres.exe"))) {
    die(`${zipName} did not contain bin/postgres.exe`);
  }
  note(sh(path.join(staging, "bin", "postgres.exe"), ["--version"], root, process.env, { capture: true }));

  // pgvector links against the tree's import library and compiles against its
  // server headers, so it has to build before `include/` is pruned.
  await buildPgvector(staging);
  prunePostgres(staging);

  fresh(target);
  for (const name of readdirSync(staging)) {
    renameSync(path.join(staging, name), path.join(target, name));
  }

  for (const entry of [
    "bin/postgres.exe",
    "lib/postgres.lib",
    "lib/uuid-ossp.dll",
    "lib/vector.dll",
    "share/extension/uuid-ossp.control",
    "share/extension/vector.control",
  ]) {
    if (!existsSync(path.join(target, entry))) {
      die(`${zipName} produced a runtime/pg without ${entry}`);
    }
  }
  note(`${relRuntime()}/pg: PostgreSQL 17 with uuid-ossp and pgvector ${pgvectorVersion}`);
}

/// pgAdmin, StackBuilder, the docs and the headers are most of the archive and
/// none of them run. Dropping them takes the tree from about 1 GB to 150 MB.
function prunePostgres(tree) {
  let bytes = 0;
  for (const name of ["pgAdmin 4", "StackBuilder", "doc", "include"]) {
    const dir = path.join(tree, name);
    if (existsSync(dir)) {
      bytes += directorySize(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  note(`dropped pgAdmin/StackBuilder/doc/include (${Math.round(bytes / 1e6)} MB)`);
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
  note(`pgvector ${declared} built against the Postgres tree (${(statSync(dll).size / 1e3).toFixed(0)} KB dll)`);
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
  // Immich pins pnpm@11.27.1 in its own `packageManager`, and corepack will fetch
  // that version when it is first used. Without this it waits for a confirmation
  // prompt that an unattended build can never answer.
  return sh(command, [...prefix, ...args], cwd, {
    ...runtimeNodeEnv(),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  });
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

  // `--check` first, so a patch that no longer applies stops with a readable
  // message instead of a half-compiled server. A checkout reused from an earlier
  // run is already patched, and that is the normal case, not an error: the diff
  // is what tells the two apart.
  const check = sh("git", ["apply", "--check", patchFile], work, process.env, { allowFailure: true });
  if (check.status === 0) {
    sh("git", ["apply", patchFile], work);
    note("applied the desktop patch");
  } else {
    const already = sh("git", ["diff", "--stat", "--", "server/src"], work, process.env, { capture: true });
    if (!already) {
      die(
        `the patch does not apply to ${immichRef}, and the checkout is not patched either.\n` +
          `  Upstream moved. Re-apply it by hand and update ${path.relative(root, patchFile)}.\n` +
          `  git said:\n${check.stderr.trim().split("\n").slice(0, 5).join("\n")}`,
      );
    }
    note("patch already applied in the reused checkout");
  }

  // The patch touches no dependency, so the lockfile is regenerated rather than
  // patched; `--frozen-lockfile` would fail on the Git-versioned one.
  pnpm(["install", "--no-frozen-lockfile"], work);
  // `immich...` builds the server and the workspace packages it imports.
  //
  // `verify-deps-before-run=false` matters on pnpm 11: before running a script it
  // compares node_modules with the lockfile and, when they disagree, runs
  // `pnpm install --prod` by itself. That install fails inside a workspace package
  // and takes the build down with it, on a tree that builds perfectly well.
  pnpm(["--config.verify-deps-before-run=false", "--filter", "immich...", "build"], work);

  const serverDir = path.join(runtime, "immich", "server");
  fresh(serverDir);
  // `node-linker=hoisted` is not a preference, it is what makes the tree movable.
  //
  // pnpm's default deploy writes the server's dependencies as symlinks whose
  // targets are the deploy directory by absolute path. Deploying to `runtime/`
  // therefore produces a tree that only works at `runtime/`, and renaming or
  // copying it dangles every link: 1,773 of them in the run that exposed this.
  // Tauri then fails the bundle with "resource path … doesn't exist" on the first
  // one it walks. A hoisted deploy writes real files, so the same tree can be
  // renamed, bundled and installed.
  try {
    pnpm(
      [
        "--config.node-linker=hoisted",
        "--config.verify-deps-before-run=false",
        "--filter",
        "immich",
        "deploy",
        "--prod",
        "--legacy",
        serverDir,
      ],
      work,
    );
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
  // The invariant the bundle depends on, checked rather than assumed: a tree with
  // a single symlink in it cannot be moved or packaged.
  const links = countSymlinks(serverDir);
  if (links > 0) {
    die(
      `the deployed server contains ${links} symlink(s), so it can only run where it was built.\n` +
        "  pnpm deploy wrote links instead of files; check that node-linker=hoisted still applies.\n" +
        `  Tauri fails the bundle on the first link it cannot resolve.`,
    );
  }
  note(`${relRuntime()}/immich/server (dist + deployed node_modules, no links)`);
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySize(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

/// Symlinks and Windows junctions both count: a junction whose target moved is as
/// broken as a symlink, and Tauri's resource walker trips over either.
function countSymlinks(dir) {
  let found = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        found += 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return found;
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
  // Built from `web/` in the pinned checkout, on every run: no `prebuilt/www` and
  // no reuse of an existing `runtime/www`. Both used to copy whatever was on disk
  // and log a line that read like a build, which is how a stale interface ships.
  const target = path.join(runtime, "www");
  if (dryRun) {
    note(`would run pnpm --config.verify-deps-before-run=false --filter immich-web build in .win-build/immich and copy web/build → runtime/www`);
    return;
  }
  if (!existsSync(path.join(work, "web"))) {
    die("the web source is missing; run without --skip-server first");
  }
  // The package is `immich-web`; `--filter web` matches nothing.
  pnpm(["--config.verify-deps-before-run=false", "--filter", "immich-web", "build"], work);
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
