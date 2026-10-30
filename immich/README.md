# The Immich patch

`v3.3.5-desktop.patch` modifies [Immich](https://github.com/immich-app/immich) v3.3.5, which
is Copyright (c) the Immich contributors and licensed AGPL-3.0. This patch, and everything
built from it, carries the same licence. See [../LICENSE](../LICENSE) and
[../NOTICE](../NOTICE).

```sh
git clone --depth 1 --branch v3.3.5 https://github.com/immich-app/immich.git
cd immich && git apply /path/to/v3.3.5-desktop.patch
```

`scripts/immich-ref.mjs` pins that revision and the patch path. The runtime assembler reads
both from there, so the patch cannot be applied to a version it was not written for.

## What it changes

| File | Change |
| --- | --- |
| `repositories/local-queue.repository.ts` (new), `app.module.ts`, `repositories/job.repository.ts` | Replaces BullMQ and Redis with a Postgres-backed queue over three tables in the app's own database. Rows are claimed with `FOR UPDATE SKIP LOCKED`, and `sweep()` returns jobs whose worker heartbeat went stale after a crash. This is what removes the Docker requirement. |
| `middleware/websocket.adapter.ts`, and the second `app.module.ts` hunk | Drops the Redis pub/sub socket.io adapter, because a single desktop process has nothing to fan events out to. |
| `repositories/map.repository.ts`, `services/metadata.service.ts` | Logs a warning and continues with no city, state or country when the geodata set that ships in Immich's Docker image is missing, instead of failing every asset that has GPS. The metadata service also moves its queue `resume()` into `finally`, so a failed geodata load cannot leave extraction paused forever. |
| `repositories/media.repository.ts`, `utils/media.ts` | sharp's Windows build has libheif without an HEVC decoder, so every HEIC thumbnail failed. HEIF files are now detected by their `ftyp` brand and decoded through FFmpeg. `utils/media.ts` asks FFmpeg for its filter list once at startup, because Immich's own image ships `tonemapx` and stock builds do not, and falls back when the filter is absent. |
| `dtos/env.dto.ts` | The env validator's absolute-path check was POSIX-only (`/^\//`), which rejected every native Windows path. It now uses `path.isAbsolute`. |
| `main.ts`, `repositories/database.repository.ts` | Worker threads and dynamic imports take a `file://` URL, because a bare `C:\...` path is parsed as a URL scheme. Both now go through `pathToFileURL`. |

Twenty-three hunks across eleven files. None of it is upstreamed. It stays a patch against a
known release so each change can be read next to the code it replaces.
