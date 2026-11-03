# Release notes

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
