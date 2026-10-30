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
3. Generated output never crosses platforms. `runtime/`, `.mac-cache/`, `.win-cache/`,
   `src-tauri/target/` and `node_modules/` are per-machine and mostly gitignored.

## macOS only

| Path | What it does |
| --- | --- |
| `src-tauri/tauri.macos.conf.json` | Bundle targets `app` + `dmg`, ad-hoc signing (`-`), no hardened runtime, macOS 11 floor. Tauri merges it automatically on a Mac. |
| `scripts/prepare-runtime-macos.mjs` | Assembles `runtime/` on a Mac: downloads Node 24 + Postgres.app + ffmpeg, builds the patched Immich with `pnpm`, prunes the PostGIS/GDAL tree, installs the arm64 `ffprobe`, builds the core plugin wasm, fetches CLIP models. |
| `scripts/build-mac.sh` | One command: runtime, typecheck, `tauri build --bundles app,dmg`, repair the bundle, re-sign, rebuild the dmg, copy it to `~/Downloads`. Sets `RUSTUP_TOOLCHAIN=stable`. |
| `scripts/repair-runtime-copy-macos.mjs` | Runs on the finished `.app` only: restores the directory symlinks Tauri's copier drops and the file symlinks it dereferences. Called by `build-mac.sh`; does nothing useful on Windows. |

macOS is also the only platform that needs `RUSTUP_TOOLCHAIN=stable` on a manual build, because
of the Windows pin below.

## Windows only

| Path | What it does |
| --- | --- |
| `src-tauri/tauri.windows.conf.json` | Bundle targets `nsis` only, per-user install (`installMode: currentUser`), English-only installer UI, LZMA. Merged on Windows only, so no MSI is built. |
| `src-tauri/rust-toolchain.toml` | Pins `stable-x86_64-pc-windows-msvc`. A Mac build **cannot** use this toolchain, so it must override the file (`RUSTUP_TOOLCHAIN=stable`), which `build-mac.sh` does. |
| `src-tauri/.cargo/config.toml` | `crt-static` rustflags, scoped to `[target.x86_64-pc-windows-msvc]`, so it is inert on a Mac. Deliberately contains **no** `[build] target`; that line is what used to break every Mac build. |
| `src-tauri/src/firewall.rs` | Inbound rule via `ShellExecuteW` on Windows; returns `true` as a no-op elsewhere. |
| `scripts/release-windows.ps1` | Runs the build, installs it silently, then checks the installed copy: installer and exe icons against `icon.ico`, the shortcut, the runtime files under `%LOCALAPPDATA%`, the file version, and a launch. No macOS counterpart; `build-mac.sh` is where the Mac stops. |
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
| `src/`, `index.html`, `vite.config.ts`, `tsconfig.json` | The hub UI. One component tree; `TitleBar.tsx` draws macOS traffic lights or Windows glyphs, and `vite.config.ts` loads the platform's own stylesheet (`@look` → `src/styles/index.css` or `src/styles/windows/app.css`), so a build carries only the look it belongs to. |
| `src-tauri/src/{lib,runtime,layout,import,watch,qr,settings,api,library,logs,probe}.rs` | The window and the supervisor. Per-platform branches: `kill_tree` (`taskkill /F /T` versus `ps` to collect descendants, then `kill -9` each — a bare `kill -9` leaves the forked `immich-api` behind), `process_name` (`tasklist` versus `ps -o comm=`), the startup orphan sweep (a documented no-op on Windows, where `tasklist` reports no path), `LC_ALL`/`LANG` for Postgres (a macOS fix, harmless on Windows), the hub address in `lib.rs`, and the native title bar that `on_page_load` hands back to the window on macOS while the library page is showing (`is_library_page`) — the hub draws its own controls, Immich draws none, so without it a Mac has nothing to grab or resize by. |
| `src-tauri/tauri.conf.json` | Shared base: window, resources (`../runtime/` to `runtime/`), icons. Each platform's `tauri.<platform>.conf.json` sets its own `targets`, so the base one is only what the bundler falls back to on an unsupported platform. |
| `src-tauri/icons/` | Every platform file (`icns`, `ico`, the PNG sizes, the Windows tile logos) is generated from `icon-source.svg` by `npx tauri icon src-tauri/icons/icon-source.svg`. Edit the SVG, never the bitmaps. |
| `src-tauri/Cargo.toml`, `Cargo.lock` | One dependency set. `qrcode` is a normal dependency because `qr.rs` draws the QR on every platform. |
| `immich/v3.3.5-desktop.patch` | The 11 upstream changes. Platform-neutral by design: no-Redis queue, ffmpeg HEIC, absolute-path fixes that work on `C:\` and `/`. |
| `ml/` | CLIP service. `fetch-models.mjs` writes to `ml/models` unless `CLIP_MODEL_DIR` says otherwise. The native half (`onnxruntime-node`, `sharp`) is installed per platform into `runtime/ml`. |
| `spike/` | M0 evidence, plus the patched Immich checkout (`.work/`, gitignored) on whichever machine has run it. |
| `src/styles/` and `src/styles/styles/` | The Mac look, and only the Mac build loads it. `system.css` holds the two walks — **Light** and **Dark**, Dark the default — as two walks of one ordered ladder for `[data-style="light"]` and `[data-style="dark"]`; the AppKit composition sits beside the components that read it, in `shell.css` for the frame, `page.css` for the section rhythm and `controls.css` for the primitives. The appearance picker, the frame colour `lib.rs` paints and the circle window controls are Mac-only for the same reason. |
| `src/styles/windows/app.css` | The Windows look, unchanged: one sheet with one appearance, the one Windows has shipped since before the appearance work. Loaded by the Windows build alone. It does not know `data-style`, the Mac rungs or the Mac shell hooks, which is why the two sheets cannot be combined. |
| `PLAN.md` | The design record: what was decided, the M0 evidence behind it, and what was rejected. |
| `LICENSE`, `NOTICE`, `docs/licensing.md` | The AGPL-3.0 text, what derives from Immich, and what every binary in a build owes. |

On macOS the chosen style also colours the window itself. `set_ui_style` in `lib.rs` sets the
window background and the native theme to match — Dark maps to the dark native theme, Light to the
light one — so the frame, scrollbars and native dialogs agree with the page. A fresh install opens
on Dark, and a `settings.json` naming a style this build no longer ships falls back to the same
frame the page falls back to. That theme also tints the real title bar the window gets back while
the library page is showing; Immich's own appearance is independent and is left alone. On Windows
`apply_style_chrome` compiles to a no-op: there is one look there, and its frame is the one the
window already has.

## Generated per machine, never copied across

| Path | Windows | macOS |
| --- | --- | --- |
| `runtime/` | `scripts/prepare-runtime-windows.mjs` | `scripts/prepare-runtime-macos.mjs` |
| `runtime/node` | Node 24 for win32-x64 | Node 24 for darwin-arm64 |
| `runtime/pg` | EnterpriseDB PostgreSQL 17, pgvector 0.8.7 compiled with MSVC, pgAdmin and headers pruned | Postgres.app `Versions/17`, GIS pruned (371 to 230 MB) |
| `runtime/ffmpeg` | gyan.dev essentials build | macOS build, `ffprobe` from `@ffprobe-installer` |
| `runtime/www` | Immich web UI build | same, compiled from the pinned checkout |
| `runtime/plugins/immich-plugin-core` | `scripts/build-core-plugin-windows.mjs` (2.5 MB) | built by the assembler (2.5 MB) |
| `runtime/ml` | `npm install` on Windows | `npm install` in `runtime/ml` on the Mac |
| `src-tauri/target` | MSVC build tree (+ `target-msvc` on this machine) | arm64 build tree |
| `.win-cache/` | downloads and toolchains for both Windows scripts | not used |
| `.mac-cache/`, `.mac-build/` | not used | downloads and the Immich checkout the assembler builds in |

The bundler copies `runtime/` verbatim into the app's resources, so a runtime built for the
wrong platform produces an app that installs and then cannot start a single service.

One path differs in a way worth knowing before checking a build, because the two Postgres
distributions lay their extensions out differently: on Windows the controls sit in
`runtime/pg/share/extension`, and on macOS Postgres.app puts them in
`runtime/pg/share/postgresql/extension`. `uuid-ossp.control` and `vector.control` are the two
Immich cannot start without.

## Telling them apart without reading this

```sh
# every platform-conditional line in the Rust
grep -rn 'cfg(windows)\|cfg(target_os = "macos")\|cfg(not(windows))' src-tauri/src

# every platform-bound file, by name
ls src-tauri/tauri.*.conf.json scripts/ src-tauri/rust-toolchain.toml
```

## One tree, no second checkout

While the two machines were diverging, this repository was unzipped beside a copy of the Mac
tree (`apps/immich-desktop-mac/`) to diff against. **That copy no longer exists, and it was never
committed**: a file is recovered from git history or from the other machine's clone, never from a
folder next to this one.

The rule it existed to protect still holds. Take a change made on the other platform as a diff
against this tree, not as a copy over it: `runtime/` and the build output are per machine, and a
copy from one undoes the fixes belonging to the other. The tables above are the whole list of
what is genuinely platform-specific, so a change that is not in them belongs in a shared file.
