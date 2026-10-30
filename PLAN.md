# Immich Desktop — plan of attack

A Tauri app that installs and runs a complete Immich server on one machine, with a
setup wizard, a LAN connection card for the phone app, and a glass UI. **v1 target:
Windows 11** — no Docker, no terminal.

**Scope: personal use only** (confirmed 28 Oct 2026) and **Windows 11 only for v1**.
One person's machine, not distributed to anyone. Personal use removes three
obligations: AGPL has no source-offer to make, code-signing certificates are
unnecessary, and there is no update feed to host. Windows-only removes two
platforms' worth of packaging. macOS and Linux stay documented in §6 as a future
option rather than being half-built now.

Status: **plan only, nothing built yet** apart from the M0 spike. This document is
the deliverable; the scaffold starts at M1.

---

## 1. What we are actually packaging

Immich is not a binary, and this is the single most important fact in the plan. The
self-hosted server is a four-service stack:

| Service | What it is | What it needs |
| --- | --- | --- |
| `immich-server` | NestJS/TypeScript server on **Node 24**. Serves the API **and** the web UI since v1.88. | `ffmpeg`/`ffprobe`, ExifTool (vendored by the npm package), `sharp` |
| `database` | PostgreSQL **14–<20** with **VectorChord** (which itself needs pgvector >= 0.7 < 0.9) | extension binaries built for the exact PG major + platform |
| `redis` | Valkey/Redis, used by BullMQ for every background job — thumbnails, metadata, transcoding, smart search, faces | Redis 6.2+ with Lua scripting |
| `immich-machine-learning` | Python **>= 3.12** service (FastAPI + onnxruntime), CPU by default | models downloaded on first use |

Ports: server **2283**, ML **3003** (loopback only). Data lives in
`UPLOAD_LOCATION` as `upload/`, `library/`, `thumbs/`, `encoded-video/`,
`profile/`, `backups/`; the database cluster is separate (`DB_DATA_LOCATION`).
`DB_URL` and `REDIS_URL` let the server point at external services — that is our
hook.

Upstream ships **no** standalone server artifact: `server/package.json` is
`private: true`, the build is `nest build` into `dist`, and the only supported
production install is Docker Compose. Native installs exist only as community
projects (arter97/immich-native on Ubuntu, NixOS module, Arch AUR, an unmaintained
macOS `.pkg`), and **none for Windows**.

Implication: "all the Immich features" is only realistic by **running the real
Immich**, not by reimplementing it. Reimplementing the feature list (timeline,
search, faces, albums, sharing, mobile upload, transcoding, dedupe, map, memories,
partner sharing…) is a multi-year product, not a desktop wrapper. The plan below
keeps upstream Immich as the engine and puts the effort where the user feels it:
install, first run, and the phone handoff.

---

## 2. The decision that shapes everything

Three routes. Each is evaluated on "wow, that was easy" first, maintenance second.

### Route A — Managed native processes (recommended)

Ship PostgreSQL + VectorChord, Node, ffmpeg and the built Immich server/web, and
supervise them as child processes from Rust. No containers, no VM, no admin
rights, and — thanks to the M0 spike — no Redis-compatible server either.

- **Pro:** smallest footprint, instant start, no virtualization, works offline
  after install, every service is inspectable, Tauri already owns process
  supervision.
- **Con:** we own the binaries. VectorChord must be built for each PG major × OS ×
  arch — one target for v1. Redis has no official Windows build, so Windows needs
  a substitute (see §3). Immich upgrades mean re-running migrations ourselves.

### Route B — Managed headless VM running upstream Docker images

Bundle a tiny Linux VM (Apple Virtualization.framework on macOS, WSL2 on Windows,
podman/systemd-nspawn on Linux) and run the official compose file inside it.

- **Pro:** perfect feature parity, upstream updates are just a tag bump, all the
  hard packaging is upstream's problem.
- **Con:** 5–10 GB, a slow first boot, WSL2 on Windows may need admin + reboot
  (fatal to "wow easy"), and the app becomes a VM manager. It also still *is*
  Docker, just hidden — which is the thing the user explicitly does not want.

### Route C — Reimplement Immich in Rust

Rejected. Not a desktop project; it is a rewrite of an application with years of
work in it. Worth revisiting only for narrow pieces (see the ML note in M4).

**Recommendation: Route A.** Route B is the fallback only if a Route A spike fails
on Windows — after M0 the open risk is the VectorChord build, not Redis.

### Consequence: a spike phase before any UI

Four things must be proven on Windows before the glass shell is worth building. If
they hold, Route A is safe. If one fails, it fails in a week, not in month three.
See M0; two of the four are already green.

---

## 3. The packaging problems, and what M0 settled

**Windows has no Redis.** Redis has no official Windows build (their docs point at
Memurai); Valkey declined Windows binaries and recommends WSL. Candidates, in
order of preference, to be settled in the M0 spike with a real BullMQ job run:

1. **Patch the queue out.** Immich's job layer is BullMQ over Redis. Replacing it
   with rows in the app's own PostgreSQL (claim, heartbeat, sweep) removes Redis
   from the stack entirely. This is a fork of one module, AGPL-permitted, and the
   most valuable outcome if it lands — but the spike has to prove BullMQ's
   semantics can be reproduced, not assumed.
2. **Garnet** (Microsoft, MIT, .NET, Windows-native, RESP): needs Lua/`EVAL`
   coverage that BullMQ's scripts exercise. Verify, don't trust.
3. **Memurai** (Windows-native, Redis-compatible, third-party licence): works, but
   its redistribution terms would need checking before shipping it to anyone —
   irrelevant for personal use, and moot now that the queue is replaced.
4. **Valkey built under MSYS2**: unsupported upstream; a build we maintain.

On macOS and Linux, bundle Valkey from source (a few MB, official, no licence
problem). **No longer needed:** replacing the queue removed Redis on every
platform, so this whole section is a record of what was tried, not pending work.

**Result:** Garnet was spiked and rejected — it executes 24 of the 25 commands
BullMQ's scripts call, but `XADD` is not one of them, and that is how BullMQ
publishes job events. Option 1 is therefore no longer speculative: a
Postgres-backed queue (jobs are rows, claimed with `FOR UPDATE SKIP LOCKED`, with
heartbeats and a stalled-job sweep) completed real thumbnail jobs on Windows with
no Redis present. A job killed mid-flight is reclaimed and re-run, and the
original API + microservices process split works again. See
[spike/RESULTS.md](spike/RESULTS.md).

**VectorChord binaries.** `postgresql_embedded` can manage a Postgres lifecycle
and accepts a *custom archive*, which is how we ship our own Postgres + pgvector +
VectorChord build per target. VectorChord lists Windows x64 and macOS as tested,
but its own docs warn about ABI mismatch with prebuilt binaries — so we build and
pin it ourselves: **Windows x64 for v1**, one archive, one version set (Postgres 17,
pgvector 0.8, VectorChord 0.4.x) tested against a fixed Immich release. macOS and
Linux archives are added only if the app ever leaves this machine, and they are
build-machine work, never user work.

If the Windows extension build cannot be made reliable, the graceful degradation is
severity-ordered: Windows falls back to Route B (WSL2) for the backend while the
desktop app stays identical; or, worst case, Windows runs with
`DB_VECTOR_EXTENSION=pgvector` if Immich still supports it, losing vector-search
quality but not the library. That decision belongs to the spike, not to opinion.

---

## 4. Architecture

```
┌──────────────────────────── Tauri app ────────────────────────────┐
│  Hub window (glass)                 Library window                │
│  status · storage · phone card      the Immich web UI, unframed   │
│  backups · logs · settings          http://127.0.0.1:2283         │
└───────────────┬───────────────────────────────────────────────────┘
                │ Rust supervisor: spawn, health, restart, shutdown
   ┌────────────┼──────────────────────────┬────────────────────────┐
   │ postgres   │ immich-server            │ immich-ml              │
   │ 127.0.0.1  │ 0.0.0.0:2283             │ 127.0.0.1:3003         │
   │ :54329     │ main → api + worker      │ python                 │
   └────────────┴──────────────────────────┴────────────────────────┘
                 all data under the folder the user chose
```

The job queue is a table in that same Postgres. There is no Redis anywhere in the
runtime (§3), and `main` forks the API and the microservices worker exactly as
upstream does — the Postgres queue is what makes that split survive a crash.

**Process model.** One Rust `Runtime` struct owning three children, started in
dependency order (postgres → server → ml), each with a health check (`pg_isready`,
`/api/server/ping`, `/ping`), an exponential restart budget, and a clean shutdown on
window close / OS logout. Windows specifics: a Job Object so children die with the
parent, and per-user autostart rather than a service — no admin rights, no UAC.
The app holds a single-instance lock exactly like Spud does, so two copies can
never share one data directory.

**Network policy.**
- Postgres binds **loopback only**, with a generated 32-char password in the
  settings file; the server gets `DB_URL` from there.
- Only 2283 is exposed, and only when "Allow phones on my network" is on (default
  on, since it is the point of the product). Loopback-only is a one-toggle mode.
- Server URL stays the immutable Immich auth model: the phone logs in with the
  user's Immich account, not a shared token.

**Data layout** — everything inside the folder the user picked:

```
<Folder>/
  immich/
    media/        upload/ library/ thumbs/ encoded-video/ profile/   (UPLOAD_LOCATION)
    database/     pgdata/                                            (DB_DATA_LOCATION)
    ml/           model cache                                         
    backups/      scheduled pg_dump + settings.json                   
    logs/         rotated, one file per service                       
  settings.json   port, folder, autostart, ML on/off, LAN on/off
```

Setup must **reject or loudly warn** on: network drives (SMB/NFS), removable
volumes, and cloud-synced folders (OneDrive, Dropbox, iCloud Drive, Google Drive
paths). Postgres over a sync client corrupts; this is the number one way a
"convenient" folder choice destroys a library, so the check runs before the
cluster is initialised, not after.

**Sizes.** Core (Postgres + Node + server + web + ffmpeg): roughly 300–450 MB
installed. ML (Python runtime + onnxruntime + opencv) adds 600 MB–1 GB,
plus models on first use. That is why ML is a post-install download with progress,
not part of the first launch — see M4. It is still installed by default, just
allowed to finish in the background.

---

## 5. First-run UX — the part that has to feel easy

Four screens, no jargon, no terminal, no ports-as-configuration:

1. **Folder.** "Where should your photos live?" with *Choose folder*.
   - **Start fresh here** — creates `immich/` inside an empty or chosen folder.
   - **Use an existing Immich folder** — scans for `media/upload`, `database/PG_VERSION`,
     `backups/`; if recognised, adopts it (verifies the DB, reuses users and
     passwords) and goes straight to *Ready*.
   - **Use a folder of photos** — if the folder holds loose images/videos but no
     Immich structure, offer the two honest paths: import them into the library
     (Immich CLI-style upload, originals copied, checksums computed) **or** attach
     them as a read-only *External Library*. Explain the difference in one line
     each: imported = Immich manages and edits; external = Immich indexes in place.
2. **Account.** Name, email, password for the admin account — the real Immich
   first-user registration via the API, so the web UI and the phone share it.
3. **Options.** Port (2283 default, with an inline conflict check), "Let phones on
   my network connect" switch, "Install smart search and face recognition" switch
   (default on, with the download size shown).
4. **Ready.** The phone card, big and copyable:

   ```
   http://192.168.1.42:2283     [Copy]   [QR]
   On your phone: Immich app → Server URL → paste → sign in
   ```

   Plus three live checks: server answers, LAN interface chosen, Windows firewall
   rule present. "Phone can't connect?" expands into: same Wi-Fi, VPN off, router
   AP-isolation, wrong network adapter.

After first run, the Hub keeps the same card permanently — interface picker when
there are several NICs/VPNs, the URL, copy, QR, and the firewall state. That card
is the deliverable the user specifically asked for, so it is a first-class screen,
not a settings row.

**Where glass applies.** The Hub and the wizard are ours: aurora field, gradient-edge
panels, shine buttons, blur on at most two surfaces, mono for addresses and paths,
`--dur: 240ms` / `--ease: cubic-bezier(.16,1,.3,1)` for everything. The Library
window is the real Immich web UI and keeps Immich's own look — injecting CSS into a
remote origin is fragile and would break on every upstream release, so it is out of
scope by design. What we can brand is Immich's own server settings (app name, theme
colour) via the admin API.

---

## 6. Milestones

Estimates assume one developer, part-time familiarity with the stack.

### M0 · Spikes — 1 week, decision gate

Throwaway scripts, no app. Windows 11 only, because that is the machine you run.

| Spike | Pass condition |
| --- | --- |
| A. Embedded Postgres + VectorChord | cluster starts from our archive; `CREATE EXTENSION vchord` works; Immich migrations run to completion |
| B. No Redis needed | server boots without `REDIS_URL` and a thumbnail job completes end to end |
| C. Immich server, no Docker | bundled Node runs `dist/main`, serves the web UI, `/api/server/ping` answers, first-user registration works |
| D. ML service | /predict for CLIP and face detection returns, from a relocatable Python, with models cached in our folder |

**Gate — passed on Windows, 27 Oct 2026; queue durability added 28 Oct.** A:
portable Postgres 17.7 with pgvector runs from a folder, no installer, no admin.
VectorChord itself needs Clang (its C shim rejects MSVC), so it becomes a CI
toolchain dependency rather than a blocker. B: no native Redis exists for Windows
and Garnet's Lua sandbox lacks `XADD`, so the queue replacement from §3 is the
answer — and C proved it, with real thumbnail jobs completing through a
Postgres-backed queue and no Redis in the process. The queue survives a kill:
jobs left active by a dead process are reclaimed within about 20 s (15 s stale
timeout, swept every 5 s) and re-run. Spike D (ML) has not been run. macOS and
Linux are out of v1 scope. Details and the eight source patches it took:
[spike/RESULTS.md](spike/RESULTS.md).

### M1 · Glass shell — 1–1.5 weeks

`apps/immich-desktop/` from `apps/interior-studio/` per
`skills/tauri-interior-app.md`: Tauri v2, React 19, Vite, pinned port,
`rust-toolchain.toml`. `src/styles/tokens.css` carries the Glass tokens; the four
primitives (button, field, tab, switch) exist before any screen. Hub window with
mock data: nav, service status rows, connection card, empty storage/backup/log
panels. Decorations-off titlebar, drag region, reduced-motion block.

**Done when:** window opens at 900 and 640 px, keyboard-only traversal works,
`tsc --noEmit` and `npm run tauri build` are clean.

**Done 28 Oct.** Hub, four views and the four primitives render Glass from
`src/styles/tokens.css`; typecheck, Vite build and the Tauri build are clean (MSI +
NSIS at 1.5–2.2 MB), and the packaged exe runs. Two deviations, both deliberate: no
Interior components and no Tailwind — Glass is its own style with its own
primitives, so copying `src/components/interior/` would mean restyling all of it;
and the custom titlebar's drag and three window controls are declared and rendered
but could not be clicked from outside the window, so they need one manual check.
See [README.md](README.md).

### M2 · Managed runtime — 2–3 weeks

Supervisor, data layout, folder init/adopt, password generation, admin creation,
health checks, restart budget, clean shutdown, single instance, crash log capture,
the log pane, and the storage screen (folder, size used, reveal in Finder/Explorer).

**Done when:** kill any child process and the app recovers or explains itself; a
full first run completes against the real stack; the library survives a hard
app kill.

### M3 · Library window + phone card — 1 week

Second window loading `http://127.0.0.1:<port>`, backed by a Tauri navigation
allow-list limited to the local origin. LAN address discovery (non-loopback IPv4,
prefer RFC1918, list all candidates, remember the user's pick), QR generation,
Windows firewall rule (installer-time, with a manual fallback path that does not
need admin), the "phone can't connect" checks.

**Done when:** a real phone on the same Wi-Fi uploads a photo through the card's
URL, and the photo appears in the Library window.

### M4 · ML + media tooling — 1–2 weeks

Bundle ffmpeg/ffprobe (LGPL builds, no GPL encoders needed for Immich's use).
Install-time ML: download the Python runtime plus a pre-built environment archive,
verify a checksum, then show smart-search/face indexing progress from the server's
own job queue. Model cache redirected into `<Folder>/immich/ml`. If manifests show
the ML payload is the reason the download is painful, the follow-up optimisation is
a Rust ONNX service implementing Immich's handful of ML endpoints (`ort` crate) —
same API, no Python. That is a later decision, not a v1 requirement.

**Done when:** smart search returns CLIP matches and face detection groups people,
offline after the one-time download.

### M5 · Memory, backup, updates — 1.5 weeks

Autostart at login (per-user, like Spud's), minimize-to-tray, remembered window
geometry, settings export/import as one JSON, scheduled `pg_dump` backups with
retention, and the update path: check a pinned Immich version, download the new
server+web bundle, snapshot the DB, run migrations, restart, roll back on failure.
Immich changes fast; a migration that cannot roll back is not shippable.

**Done when:** an update from the pinned release to the next one succeeds on a
populated library, and a deliberately broken migration leaves the old instance
running.

### M6 · Packaging and release — half a day

Windows only, personal use: NSIS with the WebView2 bootstrapper, the firewall rule
for phone access, and an uninstall that never deletes the photo folder without a
second confirmation. No paid certificate — SmartScreen shows one "unknown
publisher" prompt you click through once per machine. No notarisation, no updater
manifest to host, no clean-VM matrix: test on the machine you will use.

**Total: the milestones below add up to roughly 7–10 weeks**, down from 9–12.
M0 is the only irreversible decision and it is already spent; M6 is half a day
instead of two weeks.

**As built (Windows).** The runtime is `apps/immich-desktop/runtime` — Postgres 17
with pgvector, Node, the patched Immich server, the built web UI, and ffmpeg/
ffprobe — 888 MB unpacked, bundled through `bundle.resources` into a 210 MiB NSIS
installer. Verified by unpacking that installer and cold-starting it against an
empty library folder: fresh cluster in ~12 s, Immich UI serving, image and video
thumbnails generated from the bundled ffmpeg, ML jobs skipped rather than failed.

The setup file installs per-user to `%LOCALAPPDATA%\Immich Desktop` — no admin
prompt, no Program Files write — and unpacks in about four minutes. Walked as a
first-time user: install, empty library folder, create an account, upload, and the
phone address answered on the LAN at `192.168.x.x:port`.

Phone access used to depend on the user remembering the Windows firewall. The app
owns that now: the phone card offers **Allow through firewall**, which elevates
once for an inbound rule scoped to the bundled `node.exe` (`firewall.rs`).

That button is deliberate rather than automatic, because the first version asked
at launch and **Windows Defender deleted the application**: an unsigned exe
spawning `powershell -EncodedCommand Start-Process -Verb RunAs netsh` matches
`Trojan:PowerShell/Powdow`, and Defender quarantined the exe, the Start Menu
shortcut and the uninstall entry together. Elevation now goes through
`ShellExecuteW` with the `runas` verb — one UAC prompt, no interpreter, no
encoded script — and nothing elevates until the user clicks the button. `netsh` refuses forward slashes in a program path — "the
application contains invalid characters" — which is why the path is rewritten to
backslashes before the command, and why the same form is looked for when checking
the rule. The hub's QR code is a real one now: encoded in Rust (`qrcode`) and
rendered as SVG, with a test that decodes the generated matrix back to the address
(`rqrr`), because an SVG that merely looks like a QR code is worthless.

Builds target MSVC with a static CRT (`.cargo/config.toml`): this machine's default
GNU toolchain has no `dlltool`, so a clean build of Tauri's Windows crates fails
outright, and a static CRT means the exe needs no Visual C++ redistributable.

Smart search is real now, without Python. `ml/` is a small Node service that
answers Immich's own `/ping` and `/predict` contract using `@huggingface/transformers`
for CLIP ViT-B/32 (quantised, ~149 MB of models shipped in `models/`, no network at
runtime) and a cosine-comparable 512-dimension embedding per asset. The supervisor
starts it as a fourth child on `ml_port` (default 3003), points the server at it
with `IMMICH_MACHINE_LEARNING_URL`, and Immich queues the rest. Verified against the
real library: 5,212 assets embedded and `POST /api/search/smart` returns the
uploaded red square for "a red square".

Face recognition and OCR are **not** implemented: both need their own detector and
recogniser pipelines (InsightFace, PP-OCR) and models. The service answers those two
tasks with empty results so their jobs complete quietly instead of failing once per
asset — nothing looked, so nothing was found. The UI row says CLIP only.

Two packaging faults that only a real install exposes, both fixed in the shell:

- Windows reports the resource directory in `\\?\` verbatim form, and Postgres'
  `initdb` hands its own executable path to `cmd.exe`, which cannot parse that
  prefix — it failed with "The system cannot find the path specified" before the
  cluster existed. `layout::plain` strips the prefix from every stored path.
- A saved runtime root is only reused while it still holds a runtime; otherwise
  the bundled one wins, so a development path left in `settings.json` cannot
  outlive the folder it pointed at.

### v1 acceptance criteria

On a clean Windows 11 machine with no Docker, no Node, no Postgres and no terminal
use: install → pick a folder → create an account → **a photo from the phone lands
in the library in under ten minutes**, and the app remembers the folder, port and
switches after a restart.

### Deferred: macOS and Linux

Not built in v1. If the app ever moves, this is the work: launchd and systemd
`--user` supervision instead of a Windows Job Object, VectorChord archives per
target, an ad-hoc signed `.dmg` and a `.deb`/`.AppImage`, and a WebKitGTK check of
the Immich web UI on Ubuntu 24.04 — the one genuine rendering risk. The Rust
supervisor and the whole first-run flow are platform-neutral, so this is packaging,
not a redesign.

---

## 7. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **AGPL-3.0** — Immich is copyleft. Bundling and shipping it obliges us to offer the corresponding source, including our patches, and to keep notices. | Low — personal use confirmed | Running it on your own machines is not distribution and §13 has no remote users to serve, so no source offer is owed. Keep the licence texts and our patches in the repo regardless; that also keeps a future share trivial. |
| ~~Windows Redis substitute does not carry BullMQ~~ | Closed | M0 replaced the queue with Postgres; no Redis substitute exists in the stack, so this risk is gone rather than mitigated. |
| VectorChord ABI/extension build for Windows x64 | High | We build and pin the archive ourselves; one version set; tested against one pinned Immich release. Fallback is pgvector-only via `DB_VECTOR_EXTENSION`. |
| Cloud-synced or network folder corrupts Postgres | High, data loss | Path checks before init; refuse or require typed confirmation. |
| Installer size (ML) and slow first run | Medium | Core first, ML as verified background download with progress. |
| Linux WebKitGTK rendering of the Immich web UI | Deferred | Not v1. If Linux is ever added, test on Ubuntu 24.04 and fall back to the system browser for the Library window. |
| Unsigned build warning (SmartScreen) | Low | Personal use: click through once per machine. No certificate, no reputation building. |
| Immich upstream moves (PG version, VectorChord, env names, ML API) | Medium | Pin a release; one upgrade at a time; the app never auto-updates Immich silently. |
| Two instances / port 2283 already taken | Low | Single-instance lock, port conflict check with a suggested free port. |
| LAN exposure worries | Low | Immich's own auth; Postgres loopback-only; generated password; 2283 exposed only when phone access is on. |

---

## 8. Decisions I need from you

1. ~~**Distribution** — personal use only, or will this go to friends?~~ **Answered:
   personal use only**, and **Windows 11 only for v1** (§6). No source offer, no
   certificates, no update feed, no macOS or Linux packaging.
2. ~~**VectorChord fallback**~~ **Answered: pgvector-only.** If the Windows
   VectorChord build proves unreliable, ship `DB_VECTOR_EXTENSION=pgvector` — no VM,
   no admin, slightly worse vector search and everything else intact. Correctness of
   the "no Docker, no VM" promise outranks search quality.
3. ~~**Existing photo folder**~~ **Answered: import copies.** A folder of loose
   photos is imported by default (originals copied, checksums computed) because
   that is the path where every Immich feature works. External Library stays an
   explicit second option, described in one line at the choice.
4. ~~**ML default**~~ **Answered: installed by default, downloaded in the
   background.** First run is not blocked on a 1 GB download; smart search and
   faces finish installing while the library is already usable.

Nothing in §5–§6 changes materially based on those answers, which is why the plan is
written to proceed with M0 while they are decided.
