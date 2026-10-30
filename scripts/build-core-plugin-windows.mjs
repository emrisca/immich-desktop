#!/usr/bin/env node
/**
 * Build Immich's core workflow plugin on Windows and put it where the server
 * looks for it: `runtime/plugins/immich-plugin-core/{manifest.json,dist/plugin.wasm}`.
 *
 *   node scripts/build-core-plugin-windows.mjs
 *   node scripts/build-core-plugin-windows.mjs --checkout spike/.work/immich
 *
 * Why it is not just a package: the plugin is not on npm. It has to be compiled
 * from the same Immich checkout the server was built from, so its method list
 * matches the `@immich/plugin-sdk` that server was compiled against.
 *
 * The build is the same four steps the macOS assembler runs
 * (`scripts/prepare-runtime-macos.mjs`, `fetchCorePlugin`):
 *
 *   plugin-sdk prepareBuild   generates the host declarations from manifest.json
 *   tsc --noEmit              type-checks the plugin against them
 *   esbuild                   bundles src/index.ts to dist/index.js (CJS)
 *   extism-js                 compiles that bundle to dist/plugin.wasm, using
 *                             binaryen's wasm-merge under the hood
 *
 * Neither toolchain is on a stock Windows box, so both are fetched into
 * `.win-cache/tools` (gitignored) and their published SHA-256 is checked before
 * they are run: a truncated download shows up as a wasm that loads and then
 * traps at the first call, which is much harder to read than a checksum.
 *
 * The checkout must already have its dependencies installed (`pnpm install` at
 * the repo root). This script deliberately does not run a package manager:
 * Immich's workspace uses `workspace:*` links, and a half-finished install is
 * the failure this project's handoff already spends a page on.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".win-cache");
const tools = path.join(cache, "tools");
const runtime = path.join(root, "runtime");

const EXTISM_JS_VERSION = "1.7.0";
const BINARYEN_VERSION = "version_133";

const say = (text) => console.log(`\n▸ ${text}`);
const note = (text) => console.log(`  ${text}`);
function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });
  if (result.error) {
    die(`${path.basename(command)} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${path.basename(command)} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const checkoutArg = argv.indexOf("--checkout");
const checkout = path.resolve(
  root,
  checkoutArg >= 0 ? argv[checkoutArg + 1] : path.join("spike", ".work", "immich"),
);

// ── the checkout ─────────────────────────────────────────────────────────────

const pkg = path.join(checkout, "packages", "plugin-core");
const manifestPath = path.join(pkg, "manifest.json");

if (!existsSync(manifestPath)) {
  die(
    `no Immich checkout at ${checkout}\n` +
      `  Expected ${path.relative(root, manifestPath)}.\n` +
      `  The source is whatever tree the server under runtime/immich was built from;\n` +
      `  pass it with --checkout <path> if it lives somewhere else.`,
  );
}

const bins = path.join(pkg, "node_modules", ".bin");
const sdkEntry = path.join(pkg, "node_modules", "@immich", "plugin-sdk", "plugin-sdk.mjs");
const tscEntry = path.join(pkg, "node_modules", "typescript", "bin", "tsc");
const esbuildScript = path.join(pkg, "esbuild.js");

for (const [what, file] of [
  ["@immich/plugin-sdk", sdkEntry],
  ["typescript", tscEntry],
  ["esbuild.js", esbuildScript],
]) {
  if (!existsSync(file)) {
    die(
      `${what} is missing from ${path.relative(root, pkg)}\n` +
        `  This checkout has never had its dependencies installed. Run\n` +
        `    pnpm install --no-frozen-lockfile\n` +
        `  in ${path.relative(root, checkout)} (not in this package), then run this again.`,
    );
  }
}

// ── toolchains ───────────────────────────────────────────────────────────────

if (process.platform !== "win32") {
  die(`this is the Windows build step; on macOS use scripts/prepare-runtime-macos.mjs.`);
}

const arch = process.arch === "arm64" ? "arm64" : "x64";
// Release asset names do not agree with each other or with Node: extism calls
// this machine's build `x86_64`, binaryen calls it `x86_64` too, and Node calls
// it `x64`. Keep the two spellings separate from `arch`, which is only a label.
const binArch = process.arch === "arm64" ? "arm64" : "x86_64";

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    die(`${url} answered ${response.status}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

/// Fetch once, then verify. The `.sha256` next to every release asset is the
/// only thing that makes a cached download safe to reuse forever.
async function fetchVerified(url, destination) {
  await download(url, destination);
  const response = await fetch(`${url}.sha256`);
  if (!response.ok) {
    die(`could not fetch the checksum for ${path.basename(destination)} (${response.status})`);
  }
  // Published sums are not consistently cased between these two projects.
  const want = (await response.text()).trim().split(/\s+/)[0].toLowerCase();
  const got = createHash("sha256").update(readFileSync(destination)).digest("hex").toLowerCase();
  if (!want || want !== got) {
    die(
      `checksum mismatch for ${path.basename(destination)}\n` +
        `  expected ${want}\n  got      ${got}`,
    );
  }
  note(`✓ ${path.basename(destination)} (${(statSync(destination).size / 1e6).toFixed(1)} MB, sha256 ok)`);
}

say("Toolchains");
mkdirSync(tools, { recursive: true });

// extism-js: a single gzipped executable, published per platform and arch.
const extism = path.join(tools, "extism-js.exe");
if (existsSync(extism)) {
  note(`extism-js ${EXTISM_JS_VERSION} already in .win-cache/tools`);
} else {
  const extismArch = arch === "arm64" ? "aarch64" : "x86_64";
  const gz = path.join(tools, `extism-js-${extismArch}-windows-v${EXTISM_JS_VERSION}.gz`);
  await fetchVerified(
    `https://github.com/extism/js-pdk/releases/download/v${EXTISM_JS_VERSION}/extism-js-${extismArch}-windows-v${EXTISM_JS_VERSION}.gz`,
    gz,
  );
  // Node's own inflate rather than an external `gunzip`: the payload is a PE,
  // not text, and Windows only grew a usable tar in 1803 but never gunzip.
  writeFileSync(extism, gunzipSync(readFileSync(gz)));
  note("extism-js.exe unpacked");
}

// binaryen: a tar of the whole toolchain; only `wasm-merge` and its DLLs are used.
const binaryenBin = path.join(tools, `binaryen-${BINARYEN_VERSION}`, "bin");
const wasmMerge = path.join(binaryenBin, "wasm-merge.exe");
if (existsSync(wasmMerge)) {
  note(`binaryen ${BINARYEN_VERSION} already in .win-cache/tools`);
} else {
  const tar = path.join(tools, `binaryen-${BINARYEN_VERSION}-${binArch}-windows.tar.gz`);
  await fetchVerified(
    `https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN_VERSION}/binaryen-${BINARYEN_VERSION}-${binArch}-windows.tar.gz`,
    tar,
  );
  // Windows' own bsdtar, by absolute path: `tar` on PATH is Git Bash's GNU tar,
  // which reads `C:\...` as a remote host and fails with "Cannot connect to C:".
  // bsdtar ships with Windows 10 1803 and later. `-C` rather than a chdir so a
  // failure cannot leave the shell in the wrong directory.
  const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(existsSync(systemTar) ? systemTar : "tar", ["-xzf", tar, "-C", tools], tools);
  if (!existsSync(wasmMerge)) {
    die(`binaryen unpacked without wasm-merge in ${binaryenBin}`);
  }
  note(`wasm-merge unpacked (${(statSync(wasmMerge).size / 1e6).toFixed(1)} MB)`);
}

// ── build ────────────────────────────────────────────────────────────────────

say("Build");
// extism-js shells out to `wasm-merge`, so the unpacked binaryen bin comes first
// on PATH; the package's own .bin is there for anything that expects it.
const env = {
  PATH: [binaryenBin, tools, bins, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
};

// Through node, not the `.bin` shims: those are `.cmd` files, and since Node 18
// spawning one without a shell is either refused or deprecated depending on the
// release. The entry points behind them are ordinary .mjs/.js files.
run(process.execPath, [sdkEntry, "prepareBuild"], pkg, env);
note("plugin-sdk prepareBuild");
run(process.execPath, [tscEntry, "--noEmit"], pkg, env);
note("tsc --noEmit");
run(process.execPath, [esbuildScript], pkg, env);
note("esbuild → dist/index.js");
run(extism, ["dist/index.js", "-i", "dist/index.d.ts", "-o", "dist/plugin.wasm"], pkg, env);
note("extism-js → dist/plugin.wasm");

// ── verify before placing it ─────────────────────────────────────────────────

const wasm = path.join(pkg, "dist", "plugin.wasm");
if (!existsSync(wasm)) {
  die(`the build produced no ${path.relative(root, wasm)}`);
}
const bytes = readFileSync(wasm);
if (bytes.length < 1_000_000) {
  die(`dist/plugin.wasm is ${bytes.length} bytes — too small to be the real plugin`);
}
if (bytes.subarray(0, 4).toString("hex") !== "0061736d") {
  die("dist/plugin.wasm does not start with the wasm magic number");
}

/// extism exports one function per manifest method, so every method name has to
/// appear in the module's export section. This catches the failure that matters:
/// a build that completed against the wrong manifest and exports nothing.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const text = bytes.toString("latin1");
const missing = (manifest.methods ?? []).map((m) => m.name).filter((name) => !text.includes(name));
if (missing.length > 0) {
  die(
    `dist/plugin.wasm does not export ${missing.length} of the manifest's methods:\n` +
      `  ${missing.join(", ")}\n` +
      `  The build ran but the module does not match ${path.relative(root, manifestPath)}.`,
  );
}

const target = path.join(runtime, "plugins", "immich-plugin-core");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(manifestPath, path.join(target, "manifest.json"));
cpSync(path.join(pkg, "dist"), path.join(target, "dist"), { recursive: true });

say("Done");
note(
  `runtime/plugins/immich-plugin-core — ${manifest.name}@${manifest.version}, ` +
    `${manifest.methods?.length ?? 0} methods, ${(bytes.length / 1e6).toFixed(1)} MB wasm`,
);
note(`templates: ${(manifest.templates ?? []).map((t) => t.name).join(", ") || "none"}`);
note("Restart the app: the server imports plugins at boot, so Library → Workflows stays empty until it does.");
