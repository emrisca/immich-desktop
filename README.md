# Immich Desktop

A Tauri app that runs an Immich server on one machine without Docker. A Rust supervisor
starts Postgres, the Immich server and an optional CLIP service for smart search, and
restarts any of them that exits. The window shows those services, the library folder and
the address a phone should use. Immich's own web interface opens inside the same window.

## Licence

The project is AGPL-3.0. `immich/v3.3.5-desktop.patch` modifies Immich, and a build compiles
Immich's own `packages/plugin-core` into the workflow plugin, so both carry upstream's
licence. The shell around them uses it too, because the three ship in one installer.
[NOTICE](NOTICE) gives the commands that rebuild the corresponding source.
[docs/licensing.md](docs/licensing.md) lists every binary a build contains and what each one
requires. The FFmpeg in both runtimes is a GPL-3.0 build, which `PLAN.md` did not intend.

## Build

Windows needs Node 20+, Rust with the MSVC toolchain (pinned in
`src-tauri/rust-toolchain.toml`), and Visual Studio Build Tools with the C++ workload, which
the runtime assembler needs to compile pgvector.

```sh
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

That one command installs the npm packages, assembles `runtime/`, typechecks, builds the
installer, checks what it built, and copies it to `%USERPROFILE%\Downloads`. The checks are the
part worth knowing about: it refuses to hand over an installer whose `runtime/` is missing any
of the eleven files the supervisor needs (`node.exe`, `postgres.exe`, pgvector and `uuid-ossp`,
`ffmpeg.exe`, the server and its `kysely`, the web UI, the plugin wasm, the CLIP service), or
one under 250 MB, which is what an installer without a runtime looks like. Where 7-Zip is
installed it also lists the installer and looks for those twelve paths inside it, so the check
is on the packed file rather than the folder it was packed from. A dropped file otherwise
produces a build that reports success and an app that starts nothing.

`-SkipRuntime` reuses the `runtime/` already on disk for a rebuild after a UI or Rust change;
`--skip-ml`, `--skip-models` and the rest go through to the assembler.

```sh
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -SkipRuntime
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 --skip-ml
```

## Release

`scripts/build-windows.ps1` stops at a file in Downloads. `scripts/release-windows.ps1` goes the
rest of the way: it runs that build, installs the result silently the way a user does, and then
measures the installed copy rather than the build tree.

```sh
powershell -ExecutionPolicy Bypass -File scripts/release-windows.ps1
```

It asserts what a build cannot: the installer's own icon, the exe icon Windows draws on the
taskbar, the Start menu shortcut and the exe it points at, the eleven runtime files under
`%LOCALAPPDATA%\Immich Desktop`, the file version, and a launch that has to produce a window
before it closes the app again. Icon checks compare an 8x8 colour grid against
`src-tauri/icons/icon.ico`, so a build that ships Tauri's default art fails here. Every check
runs before the verdict, so one bad release reports all of its problems at once and exits
non-zero.

`-SkipRuntime` reuses `runtime/` for a rebuild, and `-NoLaunch` stops after the install checks on
a machine where opening the app would disturb a library in use.

For the dev loop, without packaging anything:

```sh
npm install
npm run dev          # UI only, http://localhost:1420
npm run tauri dev    # the app
npm run typecheck
```

There is one Windows installer by choice: NSIS, per user, into `%LOCALAPPDATA%\Immich Desktop`,
no administrator prompt. `src-tauri/tauri.windows.conf.json` sets that and the `nsis` block, and
narrows `targets` to it, so no MSI is built. An MSI installs per machine, needs admin, and would
copy 1.4 GB of runtime into `Program Files` for a personal app.

The installer is **not code-signed**. Windows SmartScreen therefore stops the first run with
"Windows protected your PC": *More info*, then *Run anyway*. If that button is absent, the file
came from the internet and was marked: right-click the installer, *Properties*, *Unblock*. The
Windows Firewall prompt comes next and has to be allowed on private networks, or phones cannot
reach the library.

macOS needs the same toolchain, plus `RUSTUP_TOOLCHAIN=stable`, because that pin names a Windows
target that cannot exist on a Mac. `scripts/build-mac.sh` exports it, assembles the runtime and
leaves the app and a dmg in `~/Downloads`.

```sh
bash scripts/build-mac.sh            # --skip-ml leaves out the CLIP service
```

## The runtime

`runtime/` holds the binaries a build runs: Node, PostgreSQL 17 with pgvector, FFmpeg, the
patched Immich server, its web UI, the CLIP service and the workflow plugin. It is about
1.4 GB and is not in the repository. Each platform assembles it from upstream.

```sh
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1   # Windows: runtime, installer
bash scripts/build-mac.sh                                            # macOS: runtime, bundle, dmg
```

On Windows the assembler needs Visual Studio Build Tools with the C++ workload, the same one
the Rust MSVC toolchain needs. No Windows Postgres build ships pgvector, and only EnterpriseDB's
ships `uuid-ossp`, so the assembler takes EDB's archive and compiles pgvector 0.8.7 against it.
Miss either extension and Immich fails on the first migration or the first insert.

`--skip-server`, `--skip-web`, `--skip-plugin`, `--skip-ml` and `--skip-models` assemble part
of the tree. `--runtime <dir>` writes somewhere other than `runtime/`, which is what to use
when testing the assembler without touching the runtime the app runs from.

`runtime/www` is compiled from `web/` in the pinned Immich checkout on every build. There is no
prebuilt copy to fall back on and no reuse of an earlier `runtime/www`: both used to ship
whatever interface happened to be on disk, behind a log line that read like a build.

The two runtimes are not interchangeable. The bundler copies `runtime/` into the app
unchanged, so a runtime from the other platform installs and then fails to start every
service.

## Shipping a build

`scripts/package-core-source.mjs` writes the corresponding source for a release: the pinned
upstream ref with the patch applied, packed into `release/` at 74 MB. Attach it to the release
beside the installer.

## Layout

```
LICENSE, NOTICE         AGPL-3.0 text, and what derives from Immich
docs/licensing.md       every component a build conveys, and its obligations
PLATFORMS.md            which file is Mac, which is Windows, which is neither
PLAN.md                 design record, and the M0 evidence behind it
src/styles/tokens.css   the only source of colour, radius and motion
src/styles/app.css      shell, panel recipe, primitives, views
src/ui/                 button, field, panel, switch, pill, tabs
src/app/                titlebar, sidebar, overview, storage, backups, logs, phone card
src-tauri/              the window and the supervisor: runtime, layout, import, watch, firewall, qr
  tauri.windows.conf.json NSIS only, per-user install; merged on Windows only
  tauri.macos.conf.json   app + dmg; merged on a Mac only; the rest of the bundle config is shared
  icons/icon-source.svg   the only icon art; `npx tauri icon src-tauri/icons/icon-source.svg`
                          writes every platform file from it
scripts/                runtime assemblers, per-platform build scripts, plugin build, source packaging
immich/                 the Immich patch and what each change fixes
ml/                     CLIP service for smart search
spike/                  M0 probes, and the results they produced
```

## State

`cargo test` passes in `src-tauri`, including the tests that cover how the supervisor takes its
own children back at startup. The Windows assembler has been run end to end: it built the
patched server, the web UI, the plugin and the CLIP service, and the app started every service
from the result. The server imported `immich-plugin-core@2.0.1` with 14 methods and three
templates, which is what the Workflows view lists. An existing library and its database also
came up on the rebuilt runtime, without a reset.

The macOS side has a build and a launch behind it. On 29 Oct 2026, from a fresh clone,
`bash scripts/build-mac.sh` ran end to end: Node 24 and Postgres.app copied into `runtime/`,
the patched server, the web UI and the plugin wasm built from source, typecheck clean, an app
(1.46 GiB) and a dmg produced, the repair restoring 2,102 links inside the bundle with none
dangling, the app re-signed and verifying, and both artefacts copied to `~/Downloads`. The
runtime holds `uuid-ossp`, `vector` and a 2.4 MB `plugin.wasm`.

That build was then run against a new library: the first admin was created and Immich's
onboarding ran to completion, the server imported `immich-plugin-core@2.0.1` (14 methods) and
listed three workflow templates, and a smart search for "a bee on gravel" returned the photo
that had just been uploaded. A `kill -9` of the app left a renamed `immich-api` orphan holding
port 2283, which is what the next launch now reclaims: one listener, no parentless processes.

What is still unverified here: the hub's own first-run screen and folder picker have only ever
been driven by hand, and the phone pairing has not been tried since the two trees were merged.
