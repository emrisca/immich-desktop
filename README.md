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

Windows needs Node 20+ and Rust with the MSVC toolchain, pinned in
`src-tauri/rust-toolchain.toml`.

```sh
npm install
npm run dev          # UI only, http://localhost:1420
npm run tauri dev    # the app
npm run typecheck
npm run tauri build  # MSI and NSIS installer in src-tauri/target/release/bundle
```

macOS needs the same, plus `RUSTUP_TOOLCHAIN=stable`, because that pin names a Windows target
that cannot exist on a Mac. `scripts/build-mac.sh` exports it, assembles the runtime and
leaves the app and a dmg in `~/Downloads`.

```sh
bash scripts/build-mac.sh            # --skip-ml leaves out the CLIP service
```

## The runtime

`runtime/` holds the binaries a build runs: Node, PostgreSQL 17 with pgvector, FFmpeg, the
patched Immich server, its web UI, the CLIP service and the workflow plugin. It is about
1.2 GB and is not in the repository. Each platform assembles it from upstream.

```sh
node scripts/prepare-runtime-windows.mjs     # Windows
bash scripts/build-mac.sh                    # macOS: runtime, bundle, dmg
```

On Windows the assembler needs Visual Studio Build Tools with the C++ workload, the same one
the Rust MSVC toolchain needs. PostgreSQL's Windows binaries ship no pgvector, so the
assembler compiles pgvector 0.8.7 against the Postgres tree it just unpacked. Skip that step
and Immich's first migration fails on `CREATE EXTENSION vector`.

`--skip-server`, `--skip-web`, `--skip-plugin`, `--skip-ml` and `--skip-models` assemble part
of the tree. `--runtime <dir>` writes somewhere other than `runtime/`, which is what to use
when testing the assembler without touching the runtime the app runs from.

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
  tauri.macos.conf.json   merged on a Mac only; the rest of the bundle config is shared
scripts/                runtime assembler (macOS), plugin build (Windows), source packaging
immich/                 the Immich patch and what each change fixes
ml/                     CLIP service for smart search
spike/                  M0 probes, and the results they produced
```

## State

`cargo test` passes in `src-tauri`. The core plugin builds to `immich-plugin-core@2.0.1` with
14 methods and three templates, and `wasm-opt` validates the wasm. Still unverified: a running
server importing that plugin, because the test needs the whole runtime up against a real
library.
