#!/usr/bin/env node
/**
 * Assembles `runtime/` on macOS.
 *
 * Windows assembles the same tree from upstream with
 * `scripts/prepare-runtime-windows.mjs`, and almost none of it transfers to a Mac:
 * `node.exe` is not a Mach-O
 * binary, Postgres' `bin` is PE, and `sharp` / `onnxruntime` are native modules
 * compiled per platform. This script rebuilds the same layout from upstream
 * sources, so the supervisor in `src-tauri` does not need to know which OS it is
 * on — it still finds `runtime/{node,pg,ffmpeg,immich,ml,www}`.
 *
 *   runtime/node/node              node for this Mac
 *   runtime/pg/{bin,lib,share}     PostgreSQL 17 with pgvector
 *   runtime/ffmpeg/bin/{ffmpeg,ffprobe}
 *   runtime/immich/server          patched Immich v3.3.5 server, self-contained
 *   runtime/plugins                Immich's core workflow plugin (wasm)
 *   runtime/www                    the built Immich web UI
 *   runtime/ml                     CLIP service (optional, --skip-ml)
 *
 * Usage, from the repository root:
 *
 *   node scripts/prepare-runtime-macos.mjs
 *   node scripts/prepare-runtime-macos.mjs --skip-ml --skip-models
 *   node scripts/prepare-runtime-macos.mjs --dry-run          # print the plan
 *
 * The one thing it will not do is invent a Postgres: it copies Postgres.app's
 * `Contents/Versions/17` (relocatable, pgvector included) into `runtime/pg`, or
 * downloads the dmg when the app is not installed, and it stops with
 * instructions if the `vector` extension is missing — Immich creates that
 * extension on first boot and cannot do without it.
 *
 * It deliberately does not symlink Homebrew's `postgresql@17`, which looks
 * tempting because `pg_config` is right there. Those binaries are installed
 * read-only, so `xattr -cr` during `tauri build` fails with EPERM and the app
 * never gets bundled; and a runtime made of links only runs on a Mac with that
 * exact Homebrew keg still installed.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMMICH_REF, PATCH_FILE } from "./immich-ref.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const runtime = path.join(root, "runtime");
const cache = path.join(root, ".mac-cache");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const dryRun = flag("dry-run");
const skipMl = flag("skip-ml");
const skipModels = flag("skip-models");
const arch = option("arch", process.arch === "arm64" ? "arm64" : "x64");
// The ref and the patch path live in scripts/immich-ref.mjs, so the build and
// the corresponding-source archive cannot disagree about which upstream commit
// this project is a patch against.
const immichRef = option("immich-ref", IMMICH_REF);
const patchFile = path.join(root, PATCH_FILE);
const work = path.join(root, ".mac-build");
const immichWork = path.join(work, "immich");

const POSTGRES_APP_URL = option(
  "postgres-app",
  "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-17.dmg",
);

function say(text) {
  console.log(`\x1b[1m▸ ${text}\x1b[0m`);
}

function note(text) {
  console.log(`  ${text}`);
}

function die(text) {
  console.error(`\n\x1b[31m✗ ${text}\x1b[0m`);
  process.exit(1);
}

function sh(command, args, cwd = root, env = process.env) {
  if (dryRun) {
    note(`would run: ${command} ${args.join(" ")}` + (cwd === root ? "" : `  (in ${path.relative(root, cwd)})`));
    return "";
  }
  return execFileSync(command, args, { cwd, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
}

function exists(command) {
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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

  // A dropped connection must not throw away a twenty-minute build. GitHub
  // serves release assets through a redirect to another host, and that is where
  // an `EPIPE` comes from — the first CI run died on exactly that, on the
  // extism PDK, long after Postgres and the server had been assembled.
  //
  // Only the transport is retried: a 4xx is an answer, not an accident. A failed
  // attempt removes what it wrote, so the "cached" check above can never adopt a
  // truncated file as a finished download.
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
        // Marked so the catch below stops instead of retrying a real refusal.
        Object.assign(error, { fatal: response.status < 500 });
        throw error;
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    } catch (error) {
      rmSync(destination, { force: true });
      if (error.fatal || attempt === attempts) {
        die(`${error.message} (attempt ${attempt} of ${attempts})`);
      }
      // Linear backoff: a second try immediately would meet the same bad socket.
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function fresh(dir) {
  if (!dryRun) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
  }
}

// ── node ──────────────────────────────────────────────────────────────────────
async function fetchNode() {
  say(`node (darwin-${arch})`);
  const index = dryRun
    ? [{ version: "v24.x" }]
    : await fetch("https://nodejs.org/dist/index.json").then((response) => {
        if (!response.ok) {
          die(`could not reach nodejs.org (${response.status})`);
        }
        return response.json();
      });

  // Match the major the Windows runtime ships (v24); the server only needs a
  // supported LTS, but one version across both machines is one less variable.
  const release = index.find((entry) => entry.version.startsWith("v24.")) ?? index[0];
  const tarball = `node-${release.version}-darwin-${arch}.tar.gz`;
  const url = `https://nodejs.org/dist/${release.version}/${tarball}`;
  const saved = path.join(cache, tarball);
  await download(url, saved);

  fresh(path.join(runtime, "node"));
  if (dryRun) {
    note(`would extract ${tarball} and keep bin/node`);
    return;
  }
  const unpacked = path.join(cache, `node-${release.version}-darwin-${arch}`);
  if (!existsSync(unpacked)) {
    sh("tar", ["-xzf", saved, "-C", cache]);
  }
  cpSync(path.join(unpacked, "bin", "node"), path.join(runtime, "node", "node"));
  chmodSync(path.join(runtime, "node", "node"), 0o755);
  const version = sh(path.join(runtime, "node", "node"), ["--version"]);
  note(`${release.version} → runtime/node/node (${version})`);
}

// ── postgres ──────────────────────────────────────────────────────────────────
/// Copy Postgres.app's tree without touching its symlinks.
///
/// `cpSync` resolves each link and rewrites it as an absolute path to wherever the
/// target currently is — and the target is a mount that is detached a moment
/// later, so `lib/libzstd.1.dylib` would point into a folder that no longer
/// exists and `postgres` would abort with "Library not loaded". The links inside
/// the app are relative (`libzstd.1.dylib -> libzstd.1.5.7.dylib`) and have to
/// stay that way.
function copyPostgresTree(from, to) {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  // The dmg is read-only, so every file arrives without a write bit. Two things
  // then fail: the next `tauri build` cannot copy these over themselves (EACCES),
  // and codesign cannot sign a Mach-O it cannot write to.
  execFileSync("chmod", ["-R", "u+w", to]);
  prunePostgresGis(to);
}

/// Immich asks Postgres for `vector`, `pg_trgm` and `unaccent` and never loads
/// PostGIS, but Postgres.app ships the whole GIS stack: 110 MB of a 380 MB
/// Postgres, in GDAL, GEOS, PROJ and SFCGAL plus the command line tools around
/// them. Dropping the libraries without the PostGIS modules that link them would
/// leave an extension that fails the moment it is created, so both go.
const GIS_LIBRARY = /^lib(gdal|geos|proj|SFCGAL).*\.dylib$/;
const GIS_TOOL = /^(gdal|ogr|nearblack|proj|geos|shp2pgsql|pgsql2shp|raster2pgsql|sozip|cct|cs2cs|geod|invgeod|invproj)/;
const POSTGIS_FILE = /^(postgis|spatial_ref_sys)/;

function prunePostgresGis(tree) {
  let files = 0;
  let bytes = 0;

  // Every path matched here is a file or a link to one, never a directory, so a
  // plain unlink is both enough and safe: `rmSync` refuses a link to a directory.
  const drop = (entry) => {
    const stat = lstatSync(entry);
    bytes += stat.size;
    files += 1;
    unlinkSync(entry);
  };
  const sweep = (dir, predicate, deep = false) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isDirectory()) {
        if (deep) {
          sweep(entry, predicate, true);
        }
        continue;
      }
      if (predicate(name)) {
        drop(entry);
      }
    }
  };

  sweep(path.join(tree, "lib"), (name) => GIS_LIBRARY.test(name));
  sweep(path.join(tree, "lib", "postgresql"), (name) => GIS_LIBRARY.test(name) || POSTGIS_FILE.test(name));
  sweep(path.join(tree, "bin"), (name) => GIS_TOOL.test(name));
  sweep(path.join(tree, "share", "postgresql", "extension"), (name) => POSTGIS_FILE.test(name));
  sweep(path.join(tree, "share", "man"), (name) => name.startsWith("postgis"), true);
  sweep(path.join(tree, "include"), (name) => name.startsWith("proj"));
  for (const dir of ["share/gdal", "share/proj", "lib/gdalplugins", "include/geos"]) {
    rmSync(path.join(tree, dir), { recursive: true, force: true });
  }

  // The libraries and every module or tool that linked them are gone, so nothing
  // left in the tree may still name one: check the whole of `bin` and every
  // extension module, which is what a running Postgres actually loads.
  const targets = ["bin", "lib/postgresql"].flatMap((rel) =>
    readdirSync(path.join(tree, rel)).map((name) => path.join(tree, rel, name)),
  );
  let linked = "";
  try {
    linked = execFileSync("otool", ["-L", ...targets], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    // `otool` exits non-zero when one entry is not a Mach-O (a shell script in
    // `bin`), but still prints every file it did read, which is what is needed.
    linked = String(error.stdout ?? "");
  }
  const stale = linked
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(":"))
    .filter((line) => GIS_LIBRARY.test(path.basename(line.split(" ")[0] ?? "")));
  if (stale.length > 0) {
    die(`removing the GIS libraries left these references behind:\n  ${stale.join("\n  ")}`);
  }

  note(`dropped the GIS stack (${files} files, ${Math.round(bytes / 1e6)} MB)`);
}

function postgresApp() {
  const bundled = "/Applications/Postgres.app/Contents/Versions/17";
  if (existsSync(path.join(bundled, "bin", "postgres"))) {
    return {
      bin: path.join(bundled, "bin"),
      sharedir: path.join(bundled, "share"),
      tree: bundled,
      label: "Postgres.app (/Applications)",
    };
  }
  return null;
}

async function downloadPostgresApp() {
  note("Postgres.app is not installed, so it is downloaded (relocatable binaries)");
  const dmg = path.join(cache, path.basename(POSTGRES_APP_URL));
  await download(POSTGRES_APP_URL, dmg);
  if (dryRun) {
    note("would mount the dmg, copy Contents/Versions/17 into runtime/pg, detach");
    return null;
  }

  const mount = path.join(cache, "pgapp");
  rmSync(mount, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  sh("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
  const versions = path.join(mount, "Postgres.app", "Contents", "Versions", "17");
  if (!existsSync(path.join(versions, "bin", "postgres"))) {
    sh("hdiutil", ["detach", mount, "-force"]);
    die("the Postgres.app dmg did not contain Contents/Versions/17");
  }
  fresh(path.join(runtime, "pg"));
  copyPostgresTree(versions, path.join(runtime, "pg"));
  sh("hdiutil", ["detach", mount, "-force"]);
  // The binaries in Postgres.app are relocatable, which is why copying the tree
  // out of the dmg works instead of pointing the app at a mount that disappears.
  note(`copied Versions/17 → runtime/pg`);
  return {
    bin: path.join(runtime, "pg", "bin"),
    sharedir: path.join(runtime, "pg", "share"),
    label: "Postgres.app (downloaded)",
  };
}

async function fetchPostgres() {
  say("PostgreSQL 17 (Postgres.app binaries, copied)");
  const installed = postgresApp();
  let source;
  if (installed) {
    fresh(path.join(runtime, "pg"));
    if (!dryRun) {
      copyPostgresTree(installed.tree, path.join(runtime, "pg"));
    }
    note(`copied ${installed.tree} → runtime/pg`);
    source = {
      bin: path.join(runtime, "pg", "bin"),
      sharedir: path.join(runtime, "pg", "share"),
      label: installed.label,
    };
  } else {
    source = await downloadPostgresApp();
  }
  if (!source) {
    return;
  }

  // Two layouts: Homebrew keeps `share/extension`, Postgres.app keeps
  // `share/postgresql/extension`. Look for both rather than assume one.
  const controls = [
    path.join(source.sharedir, "extension", "vector.control"),
    path.join(source.sharedir, "postgresql", "extension", "vector.control"),
  ];
  if (dryRun) {
    note(`would check ${controls.join(" or ")}`);
    return;
  }
  const control = controls.find((candidate) => existsSync(candidate));
  if (!control) {
    die(
      `pgvector is missing for this Postgres: ${control} not found.\n` +
        `  Install Postgres.app (it bundles pgvector) and run this again, or delete\n` +
        `  ${path.relative(root, path.join(runtime, "pg"))} to force a fresh copy.`,
    );
  }
  const version = sh(path.join(source.bin, "postgres"), ["--version"]);
  note(`${version} with pgvector`);
}

// ── ffmpeg ────────────────────────────────────────────────────────────────────
async function fetchFfmpeg() {
  say("ffmpeg + ffprobe");
  const staging = path.join(cache, "ffmpeg-pkg");
  if (!dryRun) {
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      path.join(staging, "package.json"),
      JSON.stringify({ name: "ffmpeg-staging", private: true, version: "0.0.0" }, null, 2),
    );
    // `@ffprobe-installer/ffprobe` rather than `ffprobe-static`: the latter ships
    // an x86_64 binary inside its `darwin/arm64` folder, so it only runs where
    // Rosetta happens to be installed. Immich calls ffprobe for every video, and
    // an arm64 build has no business depending on Rosetta.
    sh(
      "npm",
      ["install", "--no-save", "--no-audit", "--no-fund", "ffmpeg-static", "@ffprobe-installer/ffprobe"],
      staging,
    );
  } else {
    note("would npm install ffmpeg-static ffprobe-static into .mac-cache/ffmpeg-pkg");
  }

  fresh(path.join(runtime, "ffmpeg"));
  if (!dryRun) {
    mkdirSync(path.join(runtime, "ffmpeg", "bin"), { recursive: true });
    const ffmpeg = path.join(staging, "node_modules", "ffmpeg-static", "ffmpeg");
    const ffprobe = path.join(
      staging,
      "node_modules",
      "@ffprobe-installer",
      `darwin-${arch}`,
      "ffprobe",
    );
    for (const [source, name] of [
      [ffmpeg, "ffmpeg"],
      [ffprobe, "ffprobe"],
    ]) {
      if (!existsSync(source)) {
        die(            `${name} was not downloaded to ${source}.\n` +
            `  These packages fetch their binaries in a postinstall step; if that was blocked,\n` +
            `  install it by hand: brew install ffmpeg` ,
        );
      }
      cpSync(source, path.join(runtime, "ffmpeg", "bin", name));
      chmodSync(path.join(runtime, "ffmpeg", "bin", name), 0o755);
    }
    note(`runtime/ffmpeg/bin (${sh(path.join(runtime, "ffmpeg", "bin", "ffprobe"), ["-version"]).split("\n")[0]})`);
  }
}

// ── immich server ─────────────────────────────────────────────────────────────
/// The Immich build must run on the Node the runtime ships, not whichever Node
/// happens to be on PATH. v3.3.5's `.nvmrc` asks for 24.22.1; on a Node 23 the
/// Nest CLI dies with `ERR_REQUIRE_CYCLE_MODULE` while loading its schematics,
/// which reads like a dependency problem but is only the interpreter. `npm` and
/// `pnpm` are shebang scripts, so putting the runtime's `node` first on PATH is
/// enough, and it also gives `pnpm deploy`'s native rebuilds (bcrypt, sharp) the
/// ABI the app will actually load them with.
function runtimeNodeEnv() {
  const bin = path.join(runtime, "node");
  if (!existsSync(path.join(bin, "node"))) {
    return process.env;
  }
  const inherited = process.env.PATH ?? "";
  return { ...process.env, PATH: [bin, inherited].filter(Boolean).join(path.delimiter) };
}

function pnpmCommand() {
  if (exists("pnpm")) {
    return { command: "pnpm", prefix: [] };
  }
  if (exists("corepack")) {
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
    note(`would clone https://github.com/immich-app/immich.git (${immichRef}) into .mac-build/immich`);
    note(`would git apply ${path.relative(root, patchFile)}`);
    note("would pnpm install --no-frozen-lockfile, pnpm --filter immich build, pnpm --filter immich deploy --prod --legacy");
    return;
  }

  if (!existsSync(path.join(immichWork, ".git"))) {
    rmSync(immichWork, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    sh("git", ["clone", "--depth", "1", "--branch", immichRef, "https://github.com/immich-app/immich.git", immichWork]);
  } else {
    note("reusing .mac-build/immich");
  }

  // `--check` first: a patch that no longer applies should stop the build with a
  // readable message, not halfway through a compile.
  try {
    sh("git", ["apply", "--check", patchFile], immichWork);
    sh("git", ["apply", patchFile], immichWork);
    note("applied the desktop patch");
  } catch {
    const already = sh("git", ["diff", "--stat", "--", "server/src"], immichWork);
    if (!already) {
      die(
        `the patch does not apply to ${immichRef}.\n` +
          `  Upstream moved. Pin the checkout to ${immichRef} and re-apply by hand, then update\n` +
          `  ${path.relative(root, patchFile)} so both platforms patch the same way.`,
      );
    }
    note("patch already applied");
  }

  // The patch touches no dependency, so the lockfile is regenerated rather than
  // patched — `--frozen-lockfile` would fail on the Git-versioned one.
  pnpm(["install", "--no-frozen-lockfile"], immichWork);
  // `immich...` is "the server and the workspace packages it depends on". Plain
  // `--filter immich` builds only the server, whose `@immich/plugin-sdk`
  // import then fails: that package emits its `dist` from its own build script.
  pnpm(["--config.verify-deps-before-run=false", "--filter", "immich...", "build"], immichWork);

  const serverDir = path.join(runtime, "immich", "server");
  fresh(serverDir);
  try {
    pnpm(["--filter", "immich", "deploy", "--prod", "--legacy", serverDir], immichWork);
  } catch {
    die(
      "pnpm deploy failed, so there is no self-contained server to ship.\n" +
        "  Run it by hand in .mac-build/immich to see why:\n" +
        "    pnpm --filter immich deploy --prod --legacy ../../runtime/immich/server\n" +
        "  A deploy is what turns pnpm's symlinked store into real files; copying\n" +
        "  node_modules instead leaves links that break as soon as the folder moves.",
    );
  }

  // `deploy --legacy` leaves a hoisted self-link pointing back into the build
  // workspace. Nothing imports the server package by name, and the link dangles
  // the moment the .app moves out of this tree, so it must not ship.
  // `unlinkSync`, not `rmSync`: `rmSync` treats a symlink to a directory as a
  // directory and refuses it with EISDIR.
  const selfLink = path.join(serverDir, "node_modules", ".pnpm", "node_modules", "immich");
  try {
    if (lstatSync(selfLink).isSymbolicLink()) {
      unlinkSync(selfLink);
    }
  } catch {
    // Nothing to remove, which is the normal case for a fresh tree.
  }

  // `deploy` copies what the package publishes; these are the files the
  // supervisor and Immich's boot code look for, so make sure they are there.
  for (const entry of ["dist", "bin", "helmet.json", "package.json"]) {
    const from = path.join(immichWork, "server", entry);
    const to = path.join(serverDir, entry);
    if (existsSync(from) && !existsSync(to)) {
      cpSync(from, to, { recursive: true });
    }
  }
  if (!existsSync(path.join(serverDir, "dist", "main.js"))) {
    die(`the server build produced no dist/main.js in ${serverDir}`);
  }
  note("runtime/immich/server (dist + deployed node_modules)");
}

// ── core plugin ───────────────────────────────────────────────────────────────
/// Immich v3 reads workflow plugins from `IMMICH_BUILD_DATA/plugins`, and the
/// supervisor points `IMMICH_BUILD_DATA` at the runtime root. Without the core
/// plugin the server logs `Failed to import plugin … immich-plugin-core` and the
/// workflow UI has no templates to offer. It is not on npm: it is built here from
/// the same checkout the server comes from, so its method list always matches the
/// `@immich/plugin-sdk` the server was compiled against.
///
/// The build is `plugin-sdk prepareBuild` (generates the host declarations) →
/// `tsc --noEmit` → esbuild → `extism-js`, which compiles the bundle to wasm and
/// shells out to binaryen's `wasm-merge`. Both toolchains are fetched into
/// `.mac-cache/tools` and their published checksums are enforced.
const EXTISM_JS_VERSION = "1.7.0";
const BINARYEN_VERSION = "version_133";

/// Fetch once, then verify: a truncated download here surfaces as a wasm that
/// loads and then traps at runtime, which is far harder to read than a checksum.
async function fetchTool(url, destination) {
  await download(url, destination);
  if (dryRun) {
    return;
  }
  const response = await fetch(`${url}.sha256`);
  if (!response.ok) {
    die(`could not fetch the checksum for ${path.basename(destination)} (${response.status})`);
  }
  const want = (await response.text()).trim().split(/\s+/)[0];
  const got = sh("shasum", ["-a", "256", destination]).split(/\s+/)[0];
  if (!want || want !== got) {
    die(`checksum mismatch for ${path.basename(destination)}\n  expected ${want}\n  got      ${got}`);
  }
}

async function fetchCorePlugin() {
  say("Immich core plugin (workflow templates)");
  const pkg = path.join(immichWork, "packages", "plugin-core");
  if (!existsSync(path.join(pkg, "manifest.json"))) {
    die(
      `the plugin source is missing at ${pkg}.\n` +
        `  It ships in the ${immichRef} checkout fetchServer makes; run the assembler without --skip steps.`,
    );
  }

  const tools = path.join(cache, "tools");
  const extism = path.join(tools, "extism-js");
  const binaryen = path.join(tools, `binaryen-${BINARYEN_VERSION}`, "bin");
  const extismArch = arch === "arm64" ? "aarch64" : "x86_64";
  const binaryenArch = arch === "arm64" ? "arm64" : "x64";

  if (dryRun) {
    note(`would fetch extism-js ${EXTISM_JS_VERSION} and binaryen ${BINARYEN_VERSION} into .mac-cache/tools`);
    note("would run plugin-sdk prepareBuild, tsc --noEmit, esbuild, then extism-js → dist/plugin.wasm");
    note("would copy manifest.json + dist → runtime/plugins/immich-plugin-core");
    return;
  }

  const extismGz = path.join(tools, `extism-js-${extismArch}-macos-v${EXTISM_JS_VERSION}.gz`);
  await fetchTool(
    `https://github.com/extism/js-pdk/releases/download/v${EXTISM_JS_VERSION}/extism-js-${extismArch}-macos-v${EXTISM_JS_VERSION}.gz`,
    extismGz,
  );
  if (!existsSync(extism)) {
    // `sh` rather than a buffer: the decoder emits a Mach-O, not text.
    sh("sh", ["-c", `gunzip -c '${extismGz}' > '${extism}' && chmod +x '${extism}'`]);
  }

  const binaryenTar = path.join(tools, `binaryen-${BINARYEN_VERSION}-${binaryenArch}-macos.tar.gz`);
  await fetchTool(
    `https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-${binaryenArch}-macos.tar.gz`,
    binaryenTar,
  );
  if (!existsSync(binaryen)) {
    sh("tar", ["-xzf", binaryenTar, "-C", tools]);
  }
  // The archive's `wasm-merge` links `libbinaryen.dylib` from its own `lib`, so
  // the unpacked tree is used as-is and never copied elsewhere.
  if (!existsSync(path.join(binaryen, "wasm-merge"))) {
    die(`binaryen unpacked without wasm-merge in ${binaryen}`);
  }

  const env = {
    ...runtimeNodeEnv(),
    PATH: [binaryen, tools, path.join(pkg, "node_modules", ".bin"), process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const bin = (name) => path.join(pkg, "node_modules", ".bin", name);

  sh(bin("plugin-sdk"), ["prepareBuild"], pkg, env);
  sh(bin("tsc"), ["--noEmit"], pkg, env);
  // esbuild.js needs the workspace's esbuild, which resolves from the cwd.
  sh(path.join(runtime, "node", "node"), ["esbuild.js"], pkg, env);
  sh(extism, ["dist/index.js", "-i", "dist/index.d.ts", "-o", "dist/plugin.wasm"], pkg, env);

  const wasm = path.join(pkg, "dist", "plugin.wasm");
  if (!existsSync(wasm) || statSync(wasm).size < 1_000_000) {
    die(`the plugin build produced no usable ${wasm}`);
  }

  const target = path.join(runtime, "plugins", "immich-plugin-core");
  fresh(target);
  cpSync(path.join(pkg, "manifest.json"), path.join(target, "manifest.json"));
  cpSync(path.join(pkg, "dist"), path.join(target, "dist"), { recursive: true });

  const manifest = JSON.parse(readFileSync(path.join(target, "manifest.json"), "utf8"));
  note(
    `runtime/plugins/immich-plugin-core — ${manifest.name}@${manifest.version}, ` +
      `${manifest.methods?.length ?? 0} methods, ${(statSync(wasm).size / 1e6).toFixed(1)} MB wasm`,
  );
}

async function fetchWeb() {
  say("Immich web UI");
  // Built from `web/` in the pinned checkout, on every run. There used to be two
  // shortcuts here — a `prebuilt/www` folder and an existing `runtime/www` — and
  // both were silent: either one shipped whatever UI happened to be on disk, at
  // whatever age, behind a log line that read like a fresh build. A couple of
  // minutes of Vite is cheaper than an app that lies about its own version.
  const existing = path.join(runtime, "www");
  if (dryRun) {
    note("would build immich-web (pnpm --filter immich-web build) and copy web/build → runtime/www");
    return;
  }
  // The package is `immich-web`: `--filter web` matches nothing and the build
  // then reports "No projects matched the filters" and copies nothing.
  // `verify-deps-before-run=false` stops pnpm 11 comparing node_modules with the
  // lockfile and running its own `install --prod`, which fails in a workspace.
  pnpm(["--config.verify-deps-before-run=false", "--filter", "immich-web", "build"], immichWork);
  const build = path.join(immichWork, "web", "build");
  if (!existsSync(path.join(build, "index.html"))) {
    die(`the web build produced no index.html in ${build}`);
  }
  fresh(existing);
  cpSync(build, existing, { recursive: true });
  note("runtime/www built from source");
}

// ── machine learning ──────────────────────────────────────────────────────────
async function fetchMachineLearning() {
  if (skipMl) {
    say("machine learning — skipped");
    note("the app treats a missing ML service as 'not installed' and does not queue its jobs");
    return;
  }
  say("CLIP service");
  const target = path.join(runtime, "ml");
  if (!dryRun) {
    fresh(target);
    for (const file of ["index.mjs", "package.json", "smoke.mjs", "fetch-models.mjs"]) {
      cpSync(path.join(root, "ml", file), path.join(target, file));
    }
    sh("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], target, runtimeNodeEnv());
  } else {
    note("would copy ml/ and npm install --omit=dev (sharp + onnxruntime for darwin)");
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
    // installed on this machine is the one just put in `runtime/ml` — `ml/`
    // itself is never installed. So it runs from there, and writes into
    // `ml/models` through CLIP_MODEL_DIR, which the next build then reuses.
    sh("node", ["fetch-models.mjs"], target, { ...runtimeNodeEnv(), CLIP_MODEL_DIR: models });
  }
  cpSync(models, path.join(target, "models"), { recursive: true });
  note("runtime/ml/models");
}

// ── go ────────────────────────────────────────────────────────────────────────
if (process.platform !== "darwin" && !dryRun) {
  die(
    `this assembles a macOS runtime, and this machine is ${process.platform}.\n` +
      "  Run it on the Mac. (--dry-run works anywhere, for reading the plan.)",
  );
}

console.log(`\nImmich Desktop — macOS runtime (${arch})${dryRun ? "  [dry run]" : ""}\n`);
mkdirSync(cache, { recursive: true });
mkdirSync(runtime, { recursive: true });

await fetchNode();
await fetchPostgres();
await fetchFfmpeg();
await fetchServer();
await fetchCorePlugin();
await fetchWeb();
await fetchMachineLearning();

if (!dryRun) {
  say("done");
  note(`runtime assembled at ${runtime}`);
  note("next: scripts/build-mac.sh  (or: RUSTUP_TOOLCHAIN=stable npm run tauri build)");
  const oversized = ["pg", "immich", "www", "ml"].filter((dir) => existsSync(path.join(runtime, dir)));
  note(`bundled folders: ${oversized.join(", ")} — expect roughly 1 GB in the .app`);
}
