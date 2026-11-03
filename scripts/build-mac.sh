#!/usr/bin/env bash
# Build Immich Desktop on a Mac and drop the result in ~/Downloads.
#
#   scripts/build-mac.sh                    full build (app + dmg)
#   scripts/build-mac.sh --skip-ml          no CLIP service (smaller, faster)
#   scripts/build-mac.sh --skip-models      CLIP service, but no model download
#
# Needs, once: Xcode command line tools, Rust (rustup), Node 20+, pnpm, git.
#   xcode-select --install
#   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   npm i -g pnpm@11
set -euo pipefail

cd "$(dirname "$0")/.."
here=$(pwd)

# rust-toolchain.toml in src-tauri pins the Windows MSVC triple, which cannot
# exist on a Mac; RUSTUP_TOOLCHAIN takes precedence over that file.
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"

# `bundle.createUpdaterArtifacts` signs the app as it is built, so a build needs
# the private key. Locally it is the gitignored one; CI passes the same key from
# a repository secret. Losing this key means no update can ever be installed,
# because the app verifies against the public half in tauri.conf.json.
export TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-$here/.secrets/tauri-signing.key}"

for tool in node npm git; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "✗ $tool is required and not on PATH." >&2
    exit 1
  }
done
command -v cargo >/dev/null 2>&1 || {
  echo "✗ Rust is required: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
}

echo "▸ npm install"
# `--no-save` is deliberate. npm 10 rewrites `package-lock.json` on every install,
# dropping the `libc` field from the optional packages it skips on this platform
# (the glibc and musl rollup and esbuild binaries), which left 57 lines of macOS
# churn in a tracked file after each build — and a lockfile that differs from the
# one the other machine builds from. The lock is still read and installed from;
# only the write is skipped.
npm install --no-save

echo "▸ runtime for this Mac"
node scripts/prepare-runtime-macos.mjs "$@"

echo "▸ typecheck"
npm run typecheck

echo "▸ tauri build (this compiles Rust and can take a while)"
npm run tauri build -- --bundles app,dmg

bundle="$here/src-tauri/target/release/bundle"
app="$bundle/macos/Immich Desktop.app"
target="$HOME/Downloads"
mkdir -p "$target"

if [ -d "$app" ]; then
  # Both of Tauri's copy passes — the build script's into `target/release` and the
  # bundler's into the `.app` — drop any symlink that points at a directory, and a
  # pnpm `node_modules` is nothing but those. Without this the app builds happily
  # and then cannot start its server (`ERR_MODULE_NOT_FOUND: kysely`).
  echo "▸ repair the runtime inside the app"
  node scripts/repair-runtime-copy-macos.mjs "$app/Contents/Resources/runtime"

  if [ ! -f "$app/Contents/Resources/runtime/immich/server/node_modules/kysely/package.json" ]; then
    echo "✗ the packaged server lost its dependencies; the app would not start." >&2
    exit 1
  fi

  # Editing a signed bundle invalidates the signature, so sign it again — with the
  # same ad-hoc identity Tauri used — and prove it took before packaging it.
  echo "▸ re-sign the app"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app" || {
    echo "✗ the re-signed app does not verify" >&2
    exit 1
  }

  # The dmg Tauri built holds the app from before the repair, so replace it with
  # one made from this app, keeping the drag-to-Applications layout.
  # Name the image after the version being built, and clear anything an earlier
  # version left in the folder. Taking the first *.dmg the way this used to
  # returned the previous build's file, so a new version was packaged, verified
  # and copied out under the old version's name.
  shopt -s nullglob
  version=$(node -p "require('./package.json').version")
  # Tauri writes `aarch64`, uname writes `arm64`; an asset named the second way
  # sits beside the first on a release page and reads as a different build.
  case "$(uname -m)" in
    arm64) arch=aarch64 ;;
    *) arch=$(uname -m) ;;
  esac
  for stale in "$bundle"/dmg/*.dmg; do rm -f "$stale"; done
  dmg="$bundle/dmg/Immich Desktop_${version}_${arch}.dmg"
  staging=$(mktemp -d)
  ditto "$app" "$staging/Immich Desktop.app"
  ln -s /Applications "$staging/Applications"
  echo "▸ rebuild the dmg from the repaired app"
  rm -f "$dmg"
  mkdir -p "$(dirname "$dmg")"
  hdiutil create -quiet -volname "Immich Desktop" -srcfolder "$staging" -ov -format UDZO "$dmg"
  rm -rf "$staging"

  # A dmg is what people download, so it is what gets checked. An image that
  # will not verify, or an app inside it whose signature no longer matches,
  # reaches the user as "damaged and can't be opened" — the same message a
  # truncated download gives — and neither is visible from this machine.
  echo "▸ verify the dmg"
  hdiutil verify "$dmg" >/dev/null 2>&1 || {
    echo "✗ the dmg does not verify; do not publish it." >&2
    exit 1
  }
  mountpoint=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -mountpoint "$mountpoint" "$dmg" >/dev/null 2>&1 || {
    echo "✗ the dmg will not mount; do not publish it." >&2
    exit 1
  }
  codesign --verify --deep --strict "$mountpoint/Immich Desktop.app" || {
    hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
    echo "✗ the app inside the dmg does not verify; it will report as damaged." >&2
    exit 1
  }
  hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
  rmdir "$mountpoint" 2>/dev/null || true
  sha256=$(shasum -a 256 "$dmg" | cut -d' ' -f1)
  echo "  sha256 $sha256"
  echo "  put that digest in the release notes so a download can be checked"
fi

if [ -d "$app" ]; then
  rm -rf "$target/Immich Desktop.app"
  cp -R "$app" "$target/"
  # Built locally there is no quarantine flag, but copying the bundle out of the
  # build tree is exactly where one gets attached by a transfer tool.
  xattr -dr com.apple.quarantine "$target/Immich Desktop.app" 2>/dev/null || true
  echo "✓ app: $target/Immich Desktop.app"
fi

shopt -s nullglob
dmgs=("$here"/src-tauri/target/release/bundle/dmg/*.dmg)
if [ ${#dmgs[@]} -gt 0 ]; then
  cp -f "${dmgs[0]}" "$target/"
  echo "✓ dmg: $target/$(basename "${dmgs[0]}")"
fi

cat <<'NEXT'

Next:
  1. Open the app (right-click → Open the first time, it is unsigned).
  2. Pick a library folder — on the internal disk, not iCloud Drive or Desktop
     if Desktop & Documents is synced.
  3. Create the account, then open the Library and upload something.
  4. Turn "phones on this network" on and scan the QR code with the Immich app.
NEXT
