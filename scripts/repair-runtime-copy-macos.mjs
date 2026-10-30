// Repair the runtime tree Tauri copied into the bundle.
//
// Tauri's resource copy walks `runtime/` with `WalkDir` and skips anything it
// considers a directory, which includes a symlink that points at one. Links to
// files survive because they are dereferenced into real files, which is why the
// Postgres tree comes through intact. A pnpm tree does not: every dependency is
// a link into `node_modules/.pnpm`, so the packaged server kept the store and
// lost all 1,779 links to it, and died on the first import with
// `ERR_MODULE_NOT_FOUND: kysely`.
//
// So this is not a copy of the runtime, it is a repair of Tauri's copy, and it
// cannot run before the bundle exists: both of Tauri's passes strip the links
// (the build script's copy into `target/release`, then the bundler's into the
// `.app`). `build-mac.sh` runs it against the finished bundle, then re-signs,
// because editing a signed bundle invalidates the signature.
import {
  lstatSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "runtime");
// Pass the runtime directory inside the bundle; without an argument, repair the
// copy Tauri made for the build tree, which is what `tauri dev` reads on a Mac.
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "src-tauri", "target"),
      "release",
      "runtime",
    );

if (!existsSync(source)) {
  console.log("repair-runtime-copy-macos: no runtime/, nothing to mirror");
  process.exit(0);
}
if (!existsSync(target)) {
  console.log("repair-runtime-copy-macos: Tauri has not copied the runtime yet, skipping");
  process.exit(0);
}

let restored = 0;
let kept = 0;
let anchored = 0;

/// Links stay relative on purpose: an absolute one would point at this checkout,
/// or at a dmg that is detached by the time the app runs. A link whose text is
/// absolute is left as the real file Tauri dereferenced it into.
function mirror(from, to, link) {
  if (path.isAbsolute(link)) {
    anchored += 1;
    return;
  }
  const current = lstatSync(to, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && readlinkSync(to) === link) {
    kept += 1;
    return;
  }
  if (current?.isDirectory()) {
    // Tauri copied the target's contents into a real directory. Correct, and not
    // worth deleting a tree to make prettier.
    kept += 1;
    return;
  }
  // A regular file where the source has a link: Tauri dereferenced it, which is
  // how Postgres' `libicudata.75.1.dylib` ended up in the bundle three times, as
  // the real file behind each of its soname links. Replacing it with the link
  // costs nothing at runtime and gives back the 156 MB the prune just saved.
  if (current) {
    // Only if the link would resolve: a dangling link is worse than a copy.
    if (!existsSync(path.resolve(path.dirname(to), link))) {
      kept += 1;
      return;
    }
    rmSync(to, { force: true });
  }
  mkdirSync(path.dirname(to), { recursive: true });
  symlinkSync(link, to);
  restored += 1;
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    const to = path.join(target, path.relative(source, from));
    if (entry.isSymbolicLink()) {
      mirror(from, to, readlinkSync(from));
    } else if (entry.isDirectory()) {
      walk(from);
    }
  }
}

walk(source);

const total = restored + kept + anchored;
console.log(
  `repair-runtime-copy-macos: ${restored} links restored, ${kept} left as copies, ` +
    `${anchored} absolute links left dereferenced (${total} total)`,
);
