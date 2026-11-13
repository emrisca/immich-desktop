# Release notes

## 0.1.3 — A cold start that waits for its database

A hard stop leaves Postgres replaying its WAL with its port already open. When `createdb` reached
the cluster in that state it answered "the database system is starting up", and the supervisor read
that as a failed server row instead of a wait. The check the readiness probe already made now
covers `createdb` too, so recovery finishes before the server is started.

`IMMICH_BUILD_DATA` is passed whenever a runtime exists. Immich reads its web UI and its workflow
plugins from that root, and gating the variable on `www` also took the plugins away.

Machine learning is reported as present only when its dependencies are there as well as its entry
point. A runtime assembled without `ml/node_modules` started a node that exited at once, was
restarted three times, and left every smart-search job failing. Such an install now reports the
service as absent. The unused `machineLearning` setting is gone, because it claimed the service was
off while it was running.

## 0.1.2 — A macOS image that is checked before it ships

The 0.1.1 dmg arrived as "damaged and can't be opened". Nothing had checked an image before it was
attached to a release, so a disk image that would not mount, or an app inside it whose ad-hoc
signature no longer matched its contents, was first discovered by whoever downloaded it. The macOS
release job now builds through `scripts/ci-tauri.mjs`, which mounts the image it just produced,
verifies the app inside it against its designated requirement, prints the digest, and fails the job
— before anything is attached — if any of that does not hold.

`scripts/build-mac.sh` makes that check for a local build too, where the image was also named from
the first `*.dmg` already in the bundle folder: a version bump packaged the new app and then handed
it out under the previous version's filename. It is named from `package.json` now.

## 0.1.1 — One window on both platforms, and a release pipeline

The Windows build used to load its own stylesheet: the glass look, a violet aurora behind blurred
panes with a white sheen on every card. That sheet is gone. Both platforms now load the Mac's
AppKit shell, in Light or Dark, so a Windows window and a Mac window are the same window — same
sidebar, same 28px controls, same San Francisco type ladder — and the appearance picker in Settings
works on both.

Nothing is blurred any more. The toolbar that content scrolls under and the sidebar beside it are
solid surfaces in both walks, and `backdrop-filter` appears nowhere in the stylesheets. The window
opens on `#1e1e1e` rather than the glass look's `#080711`, and the shell paints that frame on
Windows too, so the title-bar area and the native dialogs agree with the page.

Releases now come from CI instead of a machine. `.github/workflows/release.yml` runs on a `v*` tag,
assembles that platform's runtime, builds the installer, signs the updater artifact and attaches
both to a published GitHub release: macOS first, then Windows. `latest.json` is written with a
signature per platform, so the update channel is live for a future in-app updater.

## 0.1.0

The first build of the hub: the supervisor for Postgres, the Immich server and the CLIP service, the
library folder picker, phone access with a QR code, backups, logs and storage.
