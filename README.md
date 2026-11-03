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

### Publishing a release

Both platforms publish from CI. Push an annotated `v<x.y.z>` tag whose version equals
`src-tauri/tauri.conf.json`, and `.github/workflows/release.yml` assembles that platform's runtime,
builds, signs the updater artifact and attaches it to a published, non-draft GitHub release —
macOS first, then Windows, which adds its own entry to the same `latest.json`. Linux has no release
job because there is no Linux runtime assembler.

```sh
npm version 0.1.2 --no-git-tag-version   # then Cargo.toml, Cargo.lock and tauri.conf.json
git commit -am "Release 0.1.2"
git tag -a v0.1.2 -m "Immich Desktop v0.1.2"
git push origin main v0.1.2
```

Signing is the one piece that is set up outside the repository. `.secrets/tauri-signing.key` holds
the private key (gitignored) and its public half is `plugins.updater.pubkey` in `tauri.conf.json`;
the workflow reads the private key from the `TAURI_SIGNING_PRIVATE_KEY` repository secret and its
password from `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty for the key as generated). Both local
build scripts point `TAURI_SIGNING_PRIVATE_KEY` at that file, because `createUpdaterArtifacts`
signs during the build — a build without it fails rather than producing an app no update can be
applied to. A tag and a config that disagree publish a release no install will ever offer: `tauri-
action` interpolates `v__VERSION__` from the config.

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
docs/mission-appearance.md  the brief the appearance work was built from, and the numbers
PLATFORMS.md            which file is Mac, which is Windows, which is neither
PLAN.md                 design record, and the M0 evidence behind it
src/styles/             the look, worn on both platforms, one file per concern — base, shell,
                        page, controls, pages/, responsive — with index.css stating the
                        import order once
src/styles/styles/      its colours: system.css, one ladder of ten rungs walked from either
                        end — light and dark — and nothing that is not about a look
src/ui/                 button, field, panel, switch, pill, tabs
src/app/                titlebar, sidebar, overview, storage, backups, logs, settings, phone card
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

## Appearance

The hub wears the macOS system look, in **Light** or **Dark**. Those are the only two appearances:
the person using it picks one in **Settings**, the row at the foot of the sidebar. The choice
applies as soon as it is clicked — there is nothing to save and nothing that can be left dirty —
and it is stored as `uiStyle` in `settings.json`, so the next launch opens in it. **Dark is the
default**, in the hub and in a fresh `settings.json` alike; an unknown or removed id (an older
build's `glass`, say) falls back to it. The library page is Immich's own and keeps its own
appearance either way.

| Look | What it is |
| --- | --- |
| **Light** | `#ECECEC` window, a flush solid sidebar under the titlebar, content directly on the window, `rgba(60,60,67,.29)` hairlines doing the containing, 28px controls, San Francisco, one blue action. |
| **Dark** | The same window at night: `#1e1e1e` window, `#409cff` accent. Not an inversion — see below for why its button is a darker blue than its text. |

There is no second look any more. The Windows build used to load its own sheet,
`src/styles/windows/app.css` — the glass look, a violet aurora behind blurred panes — and that
sheet has been deleted. Both platforms load `src/styles/index.css`, so a Windows window and a Mac
window are the same window, and the appearance picker works on both. `vite.config.ts` keeps one
`@look` alias and one flag, `isMac` in `src/app/platform.ts`, which is now true everywhere: the
pieces that arrived with the Mac look (the appearance picker, the frame colour the shell paints,
the circle window controls) read it, and nothing else has to know which platform it is on.

The glass went with that sheet. Nothing in the app is blurred: the toolbar content scrolls under
and the sidebar beside it are solid surfaces in both walks, and `backdrop-filter` appears nowhere.
The window opens on `#1e1e1e` instead of the glass look's `#080711`, and `apply_style_chrome` now
paints that frame on Windows as well, so the title-bar area and the native dialogs agree with
the page.

One file, `src/styles/styles/system.css`, answers to `<html data-style="…">` for both walks.
Every colour, radius, duration and control size a component names is defined there, and each walk
fills the same ten ordered rungs — page, sunk, hairline, boundary, three ink tiers, accent,
on-colour, flag — so Dark is a walk from the other end of the ladder, not a copy of Light's
values. Every rung is read by the shell: the ladder is exactly the surfaces a native grouped list
needs, not a superset kept for a card design that no longer ships. There is no second look to
inherit from or reconcile with: the shared token layer, the shell-composition hooks and the
Glass-era effect slots were removed with the looks that needed them. The only literals left in
the stylesheets are the traffic lights' three colours — a platform signal, not a design
choice — and the QR's white plate.

### The shell is an AppKit window

With one look there is one composition, so it is written once, directly, where the components
read it. `.shell` is a full-bleed grid: no gutter, no gap. `.panel.sidebar` is an edge of the
window — it climbs under the titlebar by `--bar-h` so the traffic lights sit on its own
surface, and a `separatorColor` rule on its right runs the full height. Every other `.panel` is a
row, not a card: 14px 0 16px, no fill, no ring, no shadow, no corners, with the page supplying
the 20px inset. Sections are separated by one hairline (`border-top: 1px solid var(--line)`),
which is how AppKit divides a grouped list. The hero and split are one column, because a 1024pt
window with a 222pt sidebar has no room for a magazine hero. The titlebar has no band of its own
and paints above the sidebar, so the stop lights and the window name land on it, as they do in
Mail or Notes.

Control geometry is still tokenised, because it is shared by every control rather than a number
buried in one: `--pad-btn`, `--pad-btn-sm`, `--pad-field`, `--pad-row` and `--pad-tab` are what
make a 28px button out of the same `.btn`, and `--radius-segment` is why the segmented control is
a 7px rounded rect rather than a capsule. `--font-label` exists for the same reason: the labels
use the text face while ports, paths and log lines stay mono everywhere.

Every text pair is measured against the surface it actually lands on. With the cards gone, both
walks put every tier on the window and the sidebar rather than on `#ffffff`/`#2c2c2e`. Against
those real composites, light measures `--ink` 14.2:1,
`--ink-2` 7.0:1, `--ink-3` 5.1:1 and accent 4.7:1 (sidebar: 15.2, 7.4, 5.3, 5.0), and dark
measures 14.9, 9.0, 6.2 and 5.9 (sidebar: 13.2, 8.1, 5.7, 5.2). The control boundary holds 3.2:1
light and 3.6:1 dark, and a white label on the button face is 5.6:1 light and 5.8:1 dark. The
**separator is deliberately not a 3:1 line**: it is `separatorColor` at 1.7:1 light and 1.6:1
dark, exactly what AppKit draws, and it is decorative — sections are also delimited by their
headings and their padding. A control whose only boundary is a hairline uses `--line-control`
(3:1+) instead, which is why `--line-field` and `--line-control` exist.

The dark walk re-measures three rungs instead of mirroring them, because a mirror reads wrong:
its `--ink-3` is 78% light and 62% dark rather than AppKit's 52%, because that tier carries
10px labels; its boundary is 60% light and 42% dark rather than 29%; and its button face is
darker than its accent so a white label clears 4.5:1 while accent text stays legible — the one
place the look needs two blues. Numbers in `docs/mission-appearance.md` §11–§13.

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

The appearance bar has been driven for real in the packaged app: on 30 Oct, from the bundle
built that morning, a real click on **Light** and then on **Dark** wrote `light` and `dark` to
`settings.json` and re-skinned the window — titlebar and frame included — in place, with no
reload. Quitting and relaunching came back on the saved look from the first painted frame:
`#ebebeb` for Light and `#1e1e1e` for Dark, never a frame of the other one. Overview, Storage
and Logs were walked in both walks. The `apple-dark` value left behind by an earlier build
opened as Dark rather than leaving the window unstyled.

What is still unverified here: the hub's own first-run screen and folder picker have only ever
been driven by hand, and the phone pairing has not been tried since the two trees were merged.
