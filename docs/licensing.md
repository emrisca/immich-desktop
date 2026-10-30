# Licensing

What is under which licence, what a build obliges you to do, and where this
departs from what `PLAN.md` intended. The short version is in [../NOTICE](../NOTICE);
this is the working document behind it.

## In the repository

| Path | Origin | Licence |
| --- | --- | --- |
| `src/`, `src-tauri/src/`, `src/ui/` | original work | AGPL-3.0-only |
| `scripts/`, `ml/`, `spike/`, `docs/`, `*.md` | original work | AGPL-3.0-only |
| `immich/v3.3.5-desktop.patch` | **modification of Immich v3.3.5** | AGPL-3.0 (upstream's) |

`AGPL-3.0-only` is the SPDX identifier used in `package.json`, `ml/package.json`
and `src-tauri/Cargo.toml`. Immich's own `package.json` says `AGPL-3.0`, which
is the deprecated identifier for the same licence; the derived parts keep
upstream's terms exactly as they are, so the two declarations agree.

The `LICENSE` file is a byte-for-byte copy of Immich's own AGPL-3.0 text with
line endings normalised — comparing `sha256sum LICENSE` against
`sha256sum <(tr -d '\r' < immich-checkout/LICENSE)` was how it was made, so it
cannot drift into a subtly edited licence.

## What a build conveys, and under what licence

None of this is in the repository. It enters the installer from `runtime/`,
which is why the obligations attach to building and shipping a bundle rather
than to pushing commits.

| Component | Version here | Source | Licence |
| --- | --- | --- | --- |
| Immich server (`dist/main.js` + deployed `node_modules`) | 3.3.5 + patch | built from the patched checkout | AGPL-3.0 |
| Immich web UI (`runtime/www`) | 3.3.5 | same build | AGPL-3.0 |
| `immich-plugin-core` wasm | 2.0.1 | `packages/plugin-core`, built by the assemblers | AGPL-3.0 |
| FFmpeg | 8.1.1 essentials | Windows: gyan.dev build. macOS: npm `ffmpeg-static` | **GPL-3.0** |
| ffprobe | same release | Windows: gyan.dev. macOS: `@ffprobe-installer/ffprobe` (LGPL-2.1) | GPL-3.0 / LGPL-2.1 |
| PostgreSQL | 17.7 | `theseus-rs/postgresql_binaries` | PostgreSQL Licence |
| pgvector | bundled with the above | `share/extension/vector*` | PostgreSQL Licence |
| Node.js | 24.22.0 | nodejs.org | MIT |
| CLIP model | `Xenova/clip-vit-base-patch32` | Hugging Face | MIT |
| CLIP service deps | — | `@huggingface/transformers` Apache-2.0, `onnxruntime-node` MIT, `sharp` Apache-2.0, `busboy` MIT | permissive |
| Tauri + Rust crates | — | crates.io | MIT or Apache-2.0 |
| extism-js, binaryen, pnpm, Vite | — | build machines only | not conveyed |

The Windows FFmpeg licence is read off the binary rather than assumed:

```
ffmpeg version 8.1.1-essentials_build-www.gyan.dev
configuration: --enable-gpl --enable-version3 … --enable-libx264 --enable-libx265 …
```

`--enable-gpl --enable-version3` plus the libx264/x265 encoders makes that build
**GPL-3.0**, not LGPL. `ffmpeg-static`, the package the macOS assembler installs,
declares `GPL-3.0-or-later`. So both platforms ship GPL FFmpeg.

To audit the parts that are generated rather than listed here:

```sh
npm ls --all                       # JS dependencies and their licences
cd src-tauri && cargo metadata --format-version 1 | jq -r '.packages[] | "\(.name) \(.license)"'
```

## What AGPL-3.0 actually asks of this program

| Clause | What it means here | State |
| --- | --- | --- |
| §5(a) | Say that the files were changed, and when | `immich/README.md` and the patch list every changed file; upstream is pinned at v3.3.5 |
| §5(b) | Keep the licence and notices with the conveyed source | `LICENSE`, `NOTICE` |
| §6 | Conveying object code requires the Corresponding Source | Produced by `scripts/package-core-source.mjs`, which still has to be attached to each release |
| §13 | Users interacting over a network get an offer of source | Not needed for the intended use; see below |
| §10 | Not sublicensable | Upstream's copyright stays with the Immich contributors, whatever this repo declares |

**§6, what a release has to carry.** A build contains the compiled Immich server,
its web UI and the plugin wasm. Anyone receiving the installer is entitled to the
source that produced them: Immich at the pinned ref *with this patch applied*.
Providing only a patch is the usual shortcut, and it reconstructs the source only
for someone who can reach the same upstream commit.

`scripts/package-core-source.mjs` writes that source. It clones the pinned ref,
applies the patch, drops `.git` and every `node_modules`, and packs the rest into
`release/immich-<ref>-desktop-source-<date>.tar.gz` with a `.sha256` beside it:
74 MB for v3.3.5, which is small next to the installer.

Two checks in that script exist because of failures seen while building it. It
refuses a source tree with no `web/src`, since a pruned working copy packs into an
archive that silently lacks the web UI. And it sets `GIT_CEILING_DIRECTORIES`
while applying the patch, because the staging tree lives inside this repository:
without the ceiling, git finds immich-desktop's own `.git`, resolves the patch
against that, and exits 0 having written nothing.

The one step no script can do is attach the archive to the release. That is an
operator action, listed below.

**§13, why it does not bite today.** The server binds loopback plus the LAN so
the operator's own phone can reach it. The person interacting over the network
is the person running the app, holding the source. The clause exists to protect
*other* users of a network service; if this ever becomes a shared instance
(family server, reverse proxy, anything with more than one operator), the app
needs to offer the source to those users — a link in the shell, or served by the
server — and that is a code change, not a licence edit.

## What GPL-3.0 FFmpeg asks

FFmpeg runs as a subprocess (`Command::new(...)` from the supervisor, and from
Immich itself), exchanging filenames and flags through its argument list. That is
aggregation, not linking: it does not make this program GPL, and it is why the
app can be AGPL and ship a GPL binary without requesting anyone's permission.
The obligations attach to the binary:

- ship FFmpeg's GPL-3.0 text (or a pointer to it) alongside the build;
- be able to supply the source of **that exact build** — gyan.dev publishes
  matching sources per release, `ffmpeg-static` publishes its build recipe;
- impose no further restriction on the conveyed FFmpeg. AGPL-3.0 and GPL-3.0 are
  compatible in both directions, so the combined distribution is fine.

## Where `PLAN.md` was wrong

`PLAN.md:324` says "Bundle ffmpeg/ffprobe (LGPL builds, no GPL encoders needed for
Immich's use)". What shipped is GPL on both platforms. Two things follow:

1. **The plan's reasoning was not tested.** Immich transcodes video, and software
   H.264 encoding lives in libx264, which is GPL. An LGPL FFmpeg build has the
   native decoder but no H.264 encoder, so "no GPL encoders needed" would have
   meant losing video transcoding or falling back to hardware encoders that are
   not present on every machine. The GPL build is the pragmatic choice; the plan
   line is left in place as the record of an intention that did not survive
   contact with the transcode path.
2. **It creates a real obligation** that an LGPL build would not have: the source
   offer for FFmpeg, as above. That is the cost of shipping the build that works.

## Before a public release

- [ ] Patched Immich tree attached to the release as Corresponding Source (§6)
- [ ] `sha256sum -c` the attached archive against the released `.sha256`
- [ ] `NOTICE` and `LICENSE` reachable from `--version` output or an About panel
- [ ] FFmpeg GPL-3.0 text and source pointer shipped in the bundle
- [ ] PostgreSQL `/copyright` included with `runtime/pg` (it is not today)
- [ ] §13 reconsidered the moment more than one person can reach the server

Nothing here is legal advice, and the §6 gap is the item that would matter to a
lawyer. The rest is bookkeeping that can be finished in an afternoon.
