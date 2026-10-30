# What is Mac, what is Windows

One project, two platforms, one tree. Most of it is neither — the hub UI, the supervisor, the
Immich patch and the CLIP service are shared, and a change to them lands on both machines.
A small, fixed set of files belong to one platform only, and this page is the whole set. If a
file is not listed here, it is shared.

Read this before copying anything between machines. The two runtime folders are not
interchangeable (`runtime/` holds this machine's binaries), and neither is the `.gitignore`d
build output.

## The rule the tree follows

1. **A platform-specific file says so in its name** — `-macos`, `-mac`, or Tauri's own
   `tauri.<platform>.conf.json`. Adding a new one means following that, not inventing a folder.
2. **Platform conditionals inside shared code are written down** — `cfg(windows)` /
   `cfg(target_os = "macos")` in Rust, `navigator.userAgent`-free platform checks in `src/`.
   Those files stay shared and are listed under "shared" below with the conditional noted.
3. **Generated output never crosses platforms** — `runtime/`, `prebuilt/`, `.mac-cache/`,
   `src-tauri/target/`, `node_modules/` are per-machine and mostly gitignored.

## macOS only

| Path | What it does |
| --- | --- |
| `src-tauri/tauri.macos.conf.json` | Bundle targets `app` + `dmg`, ad-hoc signing (`-`), no hardened runtime, macOS 11 floor. Tauri merges it automatically on a Mac. |
| `scripts/prepare-runtime-macos.mjs` | Assembles `runtime/` on a Mac: downloads Node 24 + Postgres.app + ffmpeg, builds the patched Immich with `pnpm`, prunes the PostGIS/GDAL tree, installs the arm64 `ffprobe`, builds the core plugin wasm, fetches CLIP models. |
| `scripts/build-mac.sh` | One command: runtime → typecheck → `tauri build --bundles app,dmg` → repair the bundle → re-sign → rebuild the dmg → copy to `~/Downloads`. Sets `RUSTUP_TOOLCHAIN=stable`. |
| `scripts/repair-runtime-copy-macos.mjs` | Runs on the finished `.app` only: restores the directory symlinks Tauri's copier drops and the file symlinks it dereferences. Called by `build-mac.sh`; does nothing useful on Windows. |
| `prebuilt/www/` | Staging copy of Immich's web UI used by the Mac assembler. Present in the Mac snapshot (`apps/immich-desktop-mac/prebuilt`), not in this tree. |

macOS is also the only platform that needs `RUSTUP_TOOLCHAIN=stable` on a manual build, because
of the Windows pin below.

## Windows only

| Path | What it does |
| --- | --- |
| `src-tauri/rust-toolchain.toml` | Pins `stable-x86_64-pc-windows-msvc`. A Mac build **cannot** use this toolchain, so it must override the file (`RUSTUP_TOOLCHAIN=stable`), which `build-mac.sh` does. |
| `src-tauri/.cargo/config.toml` | `crt-static` rustflags, scoped to `[target.x86_64-pc-windows-msvc]` — so it is inert on a Mac. Deliberately contains **no** `[build] target`; that line is what used to break every Mac build. |
| `src-tauri/src/firewall.rs` | Inbound rule via `ShellExecuteW` on Windows; returns `true` as a no-op elsewhere. |
| `scripts/build-core-plugin-windows.mjs` | Builds `runtime/plugins/immich-plugin-core` from the Immich checkout: fetches extism-js and binaryen into `.win-cache/tools` (checksums checked), runs `plugin-sdk prepareBuild` → `tsc --noEmit` → esbuild → extism-js, validates the wasm, and copies `manifest.json` + `dist/` into the runtime. |
| `src-tauri/src/layout.rs` | Mostly shared, but `plain()` strips the Windows `\\?\` extended-path prefix that `canonicalize` adds. The sync-folder guard (`OneDrive`, `clouddocs`, `mobile documents`) is shared. |

There is no Windows runtime assembler. `runtime/` on Windows was assembled by hand, so
`npm run tauri build` assumes it already exists. If it is ever rebuilt on a new machine, that
work is unscripted — which is why the Mac one is worth reading before starting.

## Shared — compiled or run on both

| Path | Note |
| --- | --- |
| `src/`, `index.html`, `vite.config.ts`, `tsconfig.json` | The hub UI. Identical on both; the titlebar draws macOS traffic lights or Windows glyphs at runtime from `TitleBar.tsx` + `app.css`. |
| `src-tauri/src/{lib,runtime,layout,import,watch,qr,settings,api,probe}.rs` | The window and the supervisor. Per-platform branches: `kill_tree` (`taskkill /F /T` vs `kill -9`), `LC_ALL`/`LANG` for Postgres (macOS cause, harmless on Windows), the hub address in `lib.rs`. |
| `src-tauri/tauri.conf.json` | Shared base: window, resources (`../runtime/` → `runtime/`), icons. |
| `src-tauri/Cargo.toml`, `Cargo.lock` | One dependency set. `qrcode` is a normal dependency because `qr.rs` draws the QR on every platform. |
| `immich/v3.3.5-desktop.patch` | The 11 upstream changes. Platform-neutral by design: no-Redis queue, ffmpeg HEIC, absolute-path fixes that work on `C:\` and `/`. |
| `ml/` | CLIP service. `fetch-models.mjs` writes to `ml/models` unless `CLIP_MODEL_DIR` says otherwise. The native half (`onnxruntime-node`, `sharp`) is installed per platform into `runtime/ml`. |
| `spike/` | M0 evidence, plus the patched Immich checkout (`.work/`, gitignored) on whichever machine has run it. |
| `PLAN.md` | The design record: what was decided, the M0 evidence behind it, and what was rejected. |
| `LICENSE`, `NOTICE`, `docs/licensing.md` | The AGPL-3.0 text, what derives from Immich, and what every binary in a build owes. |

## Generated per machine — never copy across

| Path | Windows | macOS |
| --- | --- | --- |
| `runtime/` | Assembled by hand | `scripts/prepare-runtime-macos.mjs` |
| `runtime/node` | Windows build | Node 24.22.2 for darwin-arm64 |
| `runtime/pg` | PostgreSQL 17 + pgvector, as installed | Postgres.app `Versions/17`, GIS pruned (371 → 230 MB) |
| `runtime/ffmpeg` | Windows binaries | macOS build, `ffprobe` from `@ffprobe-installer` |
| `runtime/www` | Immich web UI build | same, from `prebuilt/www` |
| `runtime/plugins/immich-plugin-core` | `scripts/build-core-plugin-windows.mjs` (2.5 MB) | built by the assembler (2.5 MB) |
| `runtime/ml` | `npm install` on Windows | `npm install` in `runtime/ml` on the Mac |
| `src-tauri/target` | MSVC build tree (+ `target-msvc` on this machine) | arm64 build tree |
| `.win-cache/` | toolchains and downloads for the plugin build | not used |
| `.mac-cache/`, `.mac-build/` | not used | downloads and the Immich checkout the assembler builds in |

The bundler copies `runtime/` verbatim into the app's resources, so a runtime built for the
wrong platform produces an app that installs and then cannot start a single service.

## Telling them apart without reading this

```sh
# every platform-conditional line in the Rust
grep -rn 'cfg(windows)\|cfg(target_os = "macos")\|cfg(not(windows))' src-tauri/src

# every platform-bound file, by name
ls src-tauri/tauri.*.conf.json scripts/ src-tauri/rust-toolchain.toml
```

## The Mac snapshot beside this tree

`apps/immich-desktop-mac/` is the Mac machine's tree, unzipped on 29 Oct 2026 and **not a second
project**. It is there to diff against, quote from, and recover a file if a merge went wrong.
Its `node_modules`, `runtime/`, `.mac-cache`, `.mac-build`, `dist`, `src-tauri/target` and
`ml/models` were never in it — they are re-creatable and would be 12 GB.

The Windows tree is the authority. Every shared change from the Mac is already applied here,
so `src/` and `src-tauri/src/` are identical on both sides. What differs is the Mac-only files
above, `README.md` and `.gitignore` from the merge, the Windows-only headers added to
`rust-toolchain.toml` and
`.cargo/config.toml`, the renamed repair script, `package-lock.json`, and the extra `spike/`
probes in this tree. **Take a future change from a Mac as a diff against this tree, not as a
copy over it.**
