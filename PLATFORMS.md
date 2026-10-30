# What is Mac, what is Windows

One project, two platforms, one tree. Most of it is neither. The hub UI, the supervisor, the
Immich patch and the CLIP service are shared, so a change to them lands on both machines. A
small, fixed set of files belongs to one platform only, and this page is the whole set. If a
file is not listed here, it is shared.

Read this before copying anything between machines. The two runtime folders are not
interchangeable (`runtime/` holds this machine's binaries), and neither is the `.gitignore`d
build output.

## The rule the tree follows

1. A platform-specific file says so in its name: `-macos`, `-mac`, `-windows`, or Tauri's own
   `tauri.<platform>.conf.json`. Adding a new one means following that, not inventing a folder.
2. Platform conditionals inside shared code are written down: `cfg(windows)` and
   `cfg(target_os = "macos")` in Rust, platform checks in `src/`. Those files stay shared and
   are listed under the shared table below, with the conditional noted.
3. Generated output never crosses platforms. `runtime/`, `prebuilt/`, `.mac-cache/`,
   `src-tauri/target/` and `node_modules/` are per-machine and mostly gitignored.

## macOS only

| Path | What it does |
| --- | --- |
| `src-tauri/tauri.macos.conf.json` | Bundle targets `app` + `dmg`, ad-hoc signing (`-`), no hardened runtime, macOS 11 floor. Tauri merges it automatically on a Mac. |
| `scripts/prepare-runtime-macos.mjs` | Assembles `runtime/` on a Mac: downloads Node 24 + Postgres.app + ffmpeg, builds the patched Immich with `pnpm`, prunes the PostGIS/GDAL tree, installs the arm64 `ffprobe`, builds the core plugin wasm, fetches CLIP models. |
| `scripts/build-mac.sh` | One command: runtime, typecheck, `tauri build --bundles app,dmg`, repair the bundle, re-sign, rebuild the dmg, copy it to `~/Downloads`. Sets `RUSTUP_TOOLCHAIN=stable`. |
| `scripts/repair-runtime-copy-macos.mjs` | Runs on the finished `.app` only: restores the directory symlinks Tauri's copier drops and the file symlinks it dereferences. Called by `build-mac.sh`; does nothing useful on Windows. |
| `prebuilt/www/` | Staging copy of Immich's web UI used by the Mac assembler. Present in the Mac snapshot (`apps/immich-desktop-mac/prebuilt`), not in this tree. |

macOS is also the only platform that needs `RUSTUP_TOOLCHAIN=stable` on a manual build, because
of the Windows pin below.

## Windows only

| Path | What it does |
| --- | --- |
| `src-tauri/tauri.windows.conf.json` | Bundle targets `nsis` only, per-user install (`installMode: currentUser`), English-only installer UI, LZMA. Merged on Windows only, so no MSI is built. |
| `src-tauri/rust-toolchain.toml` | Pins `stable-x86_64-pc-windows-msvc`. A Mac build **cannot** use this toolchain, so it must override the file (`RUSTUP_TOOLCHAIN=stable`), which `build-mac.sh` does. |
| `src-tauri/.cargo/config.toml` | `crt-static` rustflags, scoped to `[target.x86_64-pc-windows-msvc]`, so it is inert on a Mac. Deliberately contains **no** `[build] target`; that line is what used to break every Mac build. |
| `src-tauri/src/firewall.rs` | Inbound rule via `ShellExecuteW` on Windows; returns `true` as a no-op elsewhere. |
| `scripts/prepare-runtime-windows.mjs` | Assembles `runtime/` on Windows: downloads Node 24, EnterpriseDB's PostgreSQL 17 and gyan's ffmpeg, compiles pgvector 0.8.7 with MSVC against EDB's headers and `postgres.lib`, then drops pgAdmin, StackBuilder, docs and headers. Builds the patched Immich with `pnpm` using a hoisted deploy so the tree has no absolute symlinks, builds the web UI, calls the plugin script, and installs the CLIP service and its models. |
| `scripts/build-windows.ps1` | One command: `npm install`, the runtime assembler above, typecheck, `tauri build --bundles nsis`, then the checks — every file the supervisor needs present in the bundled `runtime/`, installer at least 250 MB, installer newer than the newest runtime file, and with 7-Zip present the same paths inside the installer itself — copies the installer to `%USERPROFILE%\Downloads`. `-SkipRuntime` reuses an assembled runtime; `--skip-*` goes to the assembler. |
| `scripts/build-core-plugin-windows.mjs` | Builds `runtime/plugins/immich-plugin-core` from the Immich checkout: fetches extism-js and binaryen into `.win-cache/tools` (checksums checked), runs `plugin-sdk prepareBuild`, `tsc --noEmit`, esbuild and extism-js, validates the wasm, then copies `manifest.json` and `dist/` into the runtime. |
| `src-tauri/src/layout.rs` | Mostly shared, but `plain()` strips the Windows `\\?\` extended-path prefix that `canonicalize` adds. The sync-folder guard (`OneDrive`, `clouddocs`, `mobile documents`) is shared. |

Both assemblies start from a fresh clone. Windows also needs Visual Studio Build Tools with the
C++ workload, because no Windows Postgres build ships pgvector and EDB's is the only one with
the `uuid-ossp` extension Immich's schema uses.

## Shared, compiled or run on both

| Path | Note |
| --- | --- |
| `src/`, `index.html`, `vite.config.ts`, `tsconfig.json` | The hub UI. Identical on both; `TitleBar.tsx` and `app.css` draw macOS traffic lights or Windows glyphs at runtime. |
| `src-tauri/src/{lib,runtime,layout,import,watch,qr,settings,api,probe}.rs` | The window and the supervisor. Per-platform branches: `kill_tree` (`taskkill /F /T` versus `kill -9`), `LC_ALL`/`LANG` for Postgres (a macOS fix, harmless on Windows), and the hub address in `lib.rs`. |
| `src-tauri/tauri.conf.json` | Shared base: window, resources (`../runtime/` to `runtime/`), icons. Each platform's `tauri.<platform>.conf.json` sets its own `targets`, so the base one is only what the bundler falls back to on an unsupported platform. |
| `src-tauri/Cargo.toml`, `Cargo.lock` | One dependency set. `qrcode` is a normal dependency because `qr.rs` draws the QR on every platform. |
| `immich/v3.3.5-desktop.patch` | The 11 upstream changes. Platform-neutral by design: no-Redis queue, ffmpeg HEIC, absolute-path fixes that work on `C:\` and `/`. |
| `ml/` | CLIP service. `fetch-models.mjs` writes to `ml/models` unless `CLIP_MODEL_DIR` says otherwise. The native half (`onnxruntime-node`, `sharp`) is installed per platform into `runtime/ml`. |
| `spike/` | M0 evidence, plus the patched Immich checkout (`.work/`, gitignored) on whichever machine has run it. |
| `PLAN.md` | The design record: what was decided, the M0 evidence behind it, and what was rejected. |
| `LICENSE`, `NOTICE`, `docs/licensing.md` | The AGPL-3.0 text, what derives from Immich, and what every binary in a build owes. |

## Generated per machine, never copied across

| Path | Windows | macOS |
| --- | --- | --- |
| `runtime/` | `scripts/prepare-runtime-windows.mjs` | `scripts/prepare-runtime-macos.mjs` |
| `runtime/node` | Node 24 for win32-x64 | Node 24 for darwin-arm64 |
| `runtime/pg` | EnterpriseDB PostgreSQL 17, pgvector 0.8.7 compiled with MSVC, pgAdmin and headers pruned | Postgres.app `Versions/17`, GIS pruned (371 to 230 MB) |
| `runtime/ffmpeg` | gyan.dev essentials build | macOS build, `ffprobe` from `@ffprobe-installer` |
| `runtime/www` | Immich web UI build | same, from `prebuilt/www` |
| `runtime/plugins/immich-plugin-core` | `scripts/build-core-plugin-windows.mjs` (2.5 MB) | built by the assembler (2.5 MB) |
| `runtime/ml` | `npm install` on Windows | `npm install` in `runtime/ml` on the Mac |
| `src-tauri/target` | MSVC build tree (+ `target-msvc` on this machine) | arm64 build tree |
| `.win-cache/` | downloads and toolchains for both Windows scripts | not used |
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

`apps/immich-desktop-mac/` is the Mac machine's tree, unzipped on 29 Oct 2026, and **not a
second project**. It is there to diff against, quote from, and recover a file if a merge went
wrong. Its `node_modules`, `runtime/`, `.mac-cache`, `.mac-build`, `dist`, `src-tauri/target`
and `ml/models` were never in it; they are re-creatable and would be 12 GB.

The Windows tree is the authority. Every shared change from the Mac is already applied here, so
`src/` and `src-tauri/src/` are identical on both sides. What differs is the Mac-only files
above, `README.md` and `.gitignore` from the merge, the Windows-only headers added to
`rust-toolchain.toml` and `.cargo/config.toml`, the renamed repair script, `package-lock.json`,
and the extra `spike/` probes in this tree. **Take a future change from a Mac as a diff against
this tree, not as a copy over it.**
