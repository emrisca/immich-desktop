#!/usr/bin/env node
/**
 * Package the Corresponding Source for a build: upstream Immich at the pinned
 * ref with `immich/v3.3.5-desktop.patch` applied.
 *
 *   node scripts/package-core-source.mjs
 *   node scripts/package-core-source.mjs --from spike/.work/immich
 *
 * A build conveys the compiled Immich server, its web UI and the core plugin
 * wasm. Immich is AGPL-3.0, so everyone who receives that build is entitled to
 * the source it came from. A patch against a public tag is not that: it only
 * reconstructs the source if the reader can fetch the same upstream commit and
 * apply it. This writes the complete patched tree as one archive, next to the
 * installer, which is what `docs/licensing.md` records as the remaining gap.
 *
 * The archive holds source only: `.git` and every `node_modules` are dropped
 * before packing. That is the difference between a 40 MB artifact and a 1 GB one,
 * and neither is needed to rebuild the server (`pnpm install` restores them).
 *
 * `--from` packs an existing checkout instead of cloning, and never writes to it:
 * the tree is copied into `.source-cache/stage` first. That exists so the
 * artifact can be produced and inspected offline, on a machine that already has
 * the checkout the runtime was built from.
 *
 * Output goes to `release/` (gitignored):
 *
 *   release/immich-v3.3.5-desktop-source-<date>.tar.gz
 *   release/immich-v3.3.5-desktop-source-<date>.tar.gz.sha256
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMMICH_REF, PATCH_FILE } from "./immich-ref.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".source-cache");
const stage = path.join(cache, "stage");
const release = path.join(root, "release");
const patchFile = path.join(root, PATCH_FILE);
const upstream = "https://github.com/immich-app/immich.git";

const say = (text) => console.log(`\n▸ ${text}`);
const note = (text) => console.log(`  ${text}`);
function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...env },
  });
  if (result.error) {
    die(`${path.basename(command)} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`${path.basename(command)} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
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

// ── options ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const refArg = argv.indexOf("--immich-ref");
const immichRef = refArg >= 0 ? argv[refArg + 1] : IMMICH_REF;
const fromArg = argv.indexOf("--from");
const from = fromArg >= 0 ? path.resolve(root, argv[fromArg + 1]) : null;

if (!existsSync(patchFile)) {
  die(`the patch is missing: ${path.relative(root, patchFile)}`);
}
if (immichRef !== IMMICH_REF) {
  note(`packing ${immichRef}, while the assemblers build ${IMMICH_REF}`);
  note("a source archive from a different ref is not the corresponding source");
}

// ── locate the source ────────────────────────────────────────────────────────

// The four things a build actually compiles into what it ships. `web` is the one
// a pruned checkout tends to be missing, and its absence is invisible until
// somebody tries to rebuild the web UI from an archive that promised to contain
// it. `spike/.work/immich` has no `web/`, which is why the check is here.
const REQUIRED = ["server/src", "web/src", "packages/plugin-core", "pnpm-lock.yaml"];
function requireComplete(dir, label) {
  const absent = REQUIRED.filter((entry) => !existsSync(path.join(dir, entry)));
  if (absent.length > 0) {
    die(
      `${label} is not a complete Immich source tree. It has no:\n  ${absent.join("\n  ")}\n` +
        "  A build conveys the server, the web UI and the core plugin, so its source\n" +
        "  has to contain all three. Clone the tagged ref instead of pointing --from\n" +
        "  at a pruned working copy.",
    );
  }
}

let source;
if (from) {
  requireComplete(from, path.relative(root, from));
  source = from;
  say(`Using the checkout at ${path.relative(root, from)}`);
} else {
  source = path.join(cache, `immich-${immichRef}`);
  if (existsSync(path.join(source, ".git"))) {
    note(`reusing ${path.relative(root, source)}`);
  } else {
    say(`Cloning ${upstream} ${immichRef}`);
    rmSync(source, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    run("git", ["clone", "--depth", "1", "--branch", immichRef, upstream, source], root);
  }
}

// ── stage a copy, without the parts that are not source ──────────────────────

say("Copying the tree into .source-cache/stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const skip = new Set(["node_modules", ".git", ".pnpm-store"]);
let copied = 0;
cpSync(source, stage, {
  recursive: true,
  dereference: false,
  filter: (entry) => {
    if (skip.has(path.basename(entry))) {
      return false;
    }
    copied += 1;
    return true;
  },
});
note(`${copied} entries, ${(directorySize(stage) / 1e6).toFixed(1)} MB`);

// ── make sure the patch is in there ─────────────────────────────────────────
//
// The patch adds `server/src/repositories/local-queue.repository.ts`, so its
// presence is the cheap test for "this tree is already patched". Checking the
// file rather than `git diff` keeps this working on a checkout with no `.git`.

const marker = path.join(stage, "server", "src", "repositories", "local-queue.repository.ts");
if (existsSync(marker)) {
  note("patch already applied in the source tree");
} else {
  say("Applying the desktop patch");
  // `git apply` needs no repository, only the working tree, and `--check` first
  // means a patch that no longer applies stops here rather than leaving a
  // half-patched archive that looks complete.
  //
  // The ceiling matters: `.source-cache/stage` sits inside this repository, so
  // without it git walks up, finds immich-desktop's own `.git` and resolves the
  // patch against that instead of the staged tree. It exits 0 and writes
  // nothing, which is why the marker check below exists.
  const plainWorkTree = { GIT_CEILING_DIRECTORIES: cache };
  run("git", ["apply", "--check", patchFile], stage, plainWorkTree);
  run("git", ["apply", patchFile], stage, plainWorkTree);
}

if (!existsSync(marker)) {
  die(
    "the staged tree has no local-queue.repository.ts, so the patch did not land.\n" +
      `  Check that ${PATCH_FILE} still applies to ${immichRef}.`,
  );
}

// Every file the patch mentions has to be present, or the archive is incomplete
// in a way a reader would only discover while rebuilding.
const touched = new Set();
for (const line of readFileSync(patchFile, "utf8").split("\n")) {
  const match = /^diff --git a\/(.+?) b\//.exec(line);
  if (match) {
    touched.add(match[1]);
  }
}
const missing = [...touched].filter((file) => !existsSync(path.join(stage, file)));
if (missing.length > 0) {
  die(`the staged tree is missing ${missing.length} patched file(s):\n  ${missing.join("\n  ")}`);
}
note(`${touched.size} patched files present`);
requireComplete(stage, "the staged tree");

// ── say what the archive is, inside the archive ─────────────────────────────

const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(
  path.join(stage, "CORRESPONDING-SOURCE.txt"),
  `Corresponding Source for the immich-desktop build of ${stamp}

This is upstream Immich ${immichRef} with immich-desktop's changes applied, which
is the source the shipped server, web UI and immich-plugin-core were built from.
Immich is Copyright (c) the Immich contributors and licensed AGPL-3.0 (see
LICENSE in this archive). The immich-desktop changes are licensed the same way.

Upstream: ${upstream}
Revision: ${immichRef}
Patch:    ${PATCH_FILE} (already applied here; kept in the immich-desktop
          repository so the changes stay reviewable against a known release)

To rebuild what a release contains, on macOS:

    git clone --depth 1 --branch ${immichRef} ${upstream}
    git apply ${path.basename(PATCH_FILE)}
    bash scripts/prepare-runtime-macos.mjs

The generated installer bundles this tree, so it is offered with the installer
rather than kept back. If you received a build without this archive, ask for it.
`,
);

// ── pack ────────────────────────────────────────────────────────────────────

say("Packing");
mkdirSync(release, { recursive: true });
const name = `immich-${immichRef}-desktop-source-${stamp}.tar.gz`;
const tarball = path.join(release, name);

// Git Bash's GNU `tar` reads `C:\…` as a remote host and fails with
// "Cannot connect to C:". Windows' own bsdtar takes the same flags.
const tar =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
if (process.platform === "win32" && !existsSync(tar)) {
  die(`no bsdtar at ${tar}; Windows 10 1803 or newer ships one`);
}
rmSync(tarball, { force: true });
run(tar, ["-czf", tarball, "-C", stage, "."], root);

const size = statSync(tarball).size;
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(`${tarball}.sha256`, `${digest}  ${name}\n`);

note(`${(size / 1e6).toFixed(1)} MB, sha256 ${digest.slice(0, 16)}…`);

say("Done");
note(path.relative(root, tarball));
note(`${path.relative(root, tarball)}.sha256`);
note("");
note("Attach both files to the release next to the installer, and link the");
note("archive from the release notes. Verify with:");
note(`  sha256sum -c ${name}.sha256`);
