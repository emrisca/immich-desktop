# Release notes

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
