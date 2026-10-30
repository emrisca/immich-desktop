# M0 spike — results

Executed on Windows 11 (10.0.26200), Node 24.22, Rust 1.99 (msvc), VS 2022.
Immich **v3.3.5**, PostgreSQL **17.7**, pgvector **0.8.7**, VectorChord **1.1.1**,
BullMQ 5.81 / ioredis 5.11 for the control test.

Verdict: **Route A is viable.** The queue can be replaced with a durable
Postgres-backed one, and real Immich jobs run end to end with no Redis in the
process — including after the process is killed mid-job. Two platform gaps remain,
both understood and both fixable.

---

## 1. Postgres on Windows — PASS

`postgresql-17.7.0-x86_64-pc-windows-msvc` from `theseus-rs/postgresql-binaries`,
extracted to a folder, `initdb`, started on 54329. It ships `pg_config`, server
headers, `postgres.lib` and the static libs, so extensions can be compiled
against it. No installer, no service, no admin rights.

One operational note: `pg_ctl -w start` hangs in Git Bash even though the server
comes up, so a supervisor must spawn `postgres.exe` and poll readiness itself
(which the app would do anyway).

## 2. pgvector on Windows — PASS

Compiled from source with MSVC (`nmake /F Makefile.win`, `PGROOT` pointed at the
portable tree), installed into it, `CREATE EXTENSION vector` and a distance query
returned the expected result. This matters because Immich has a first-class
pgvector branch: `vectorIndexQuery()` builds a real HNSW index
(`USING hnsw … vector_cosine_ops`) for `DatabaseExtension.Vector`, so pgvector is
a supported target, not a stub.

## 3. VectorChord on Windows — BLOCKED ON TOOLCHAIN

`cargo pgrx package --features pg17` fails in its C shim:

```
./cshim/x86_64_fp16.c(24): fatal error C1189: #error: "This file requires Clang or GCC."
```

No Windows or macOS binaries are published (releases carry Linux `.deb` and
`linux-gnu` zips only), and `release.yml` builds on Ubuntu only. So a Windows or
macOS `vchord.dll` has to be built by whoever ships the app, with LLVM installed
in CI. pgrx documents LLVM as a Windows prerequisite for exactly this reason.
This is a build-machine cost, never a user cost — users get the prebuilt DLL.
Fallback if it proves unreliable: ship pgvector-only on that platform, already
proven above.

## 4. Redis on Windows — NO NATIVE OPTION, Garnet REJECTED

- Redis has no official Windows build; Valkey publishes none either.
- **Garnet 2.2.4** runs natively and is MIT, but with `--lua` its sandbox
  executes 24 of the 25 commands BullMQ's scripts use — and the missing one is
  `XADD`, which is how BullMQ publishes job events. It fails on the first `add`.
  Probe: `garnet-lua-probe.mjs`.
- **Valkey 8 on Linux: PASS.** BullMQ drove 12/12 jobs to completion with correct
  return values, which also validates the smoke test itself.
  (`bullmq-smoke.mjs`)

## 5. Postgres-backed queue replacing BullMQ — PASS

`server/src/repositories/local-queue.repository.ts` implements the surface
`JobRepository` uses (`add`, `addBulk`, `getJobCounts`, `getActiveCount`,
`isPaused`/`pause`/`resume`, `drain`, `clean`, `getJobs`, `getJob`, `getWorkers`)
plus a `LocalWorker` with a mutable concurrency. No Redis client is instantiated
anywhere in the running process (`netstat` shows nothing on 6379 and there is no
Redis/Valkey/Garnet process on the machine).

Jobs are rows in the app's own database, so they outlive the process:

| Table | Purpose |
| --- | --- |
| `local_queue_job` | one row per job: payload, opts, status, `run_at`, attempts, owner, heartbeat |
| `local_queue_state` | per-queue paused flag |
| `local_queue_worker` | live worker registrations, refreshed every 5 s |

- **Claiming** is one conditional `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)`,
  ordered by `priority NULLS LAST, seq` — FIFO per priority, one worker per row.
- **Crashes**: an `active` row whose worker stopped heartbeating (15 s) is put
  back in the queue by `sweep()`; the next claim re-runs it. Recovery measured at
  **5.6 s** after restart, with `attempts = 2` on exactly the interrupted jobs.
- **Retries** honour `opts.attempts` and `opts.backoff` (fixed and exponential);
  a job that throws twice with `attempts: 3` ends `completed` on the third run.
- **Graceful shutdown** hands in-flight work straight back to `waiting`, so a
  clean quit does not wait for the stall timeout.
- **Two processes**: the API and the microservices worker each claim from the same
  table. 8 jobs split 6/2 across two workers with **0 jobs attempted twice**.
- Bulk inserts keep insertion order (`seq` identity column), and `data`/`opts` are
  stored as jsonb objects — passing pre-stringified JSON to the driver would store
  a JSON *string* and break every handler.

No LISTEN/NOTIFY: an enqueue in this process wakes its worker directly and a 1 s
poll covers delayed jobs and the other process. That is a deliberate simplification
— latency, not durability.

Evidence (`queue-durability-test.mjs`, `queue-persistence-app-test.mjs`):

```
CRASH PHASE PASS (2 active, 4 waiting)        # killed with no settle, no release
RECOVER PHASE PASS
completed=6 failed=0 active=0 waiting=0
recovered after crash: 2 job(s) with attempts >= 2
flaky retried 3x and ended "completed"
recovery took 5.6s
GRACEFUL CLOSE PASS: active 2 -> 0, waiting 2
CONTEND PHASE PASS: completed=8 failed=0 waiting=0, split {a:6,b:2}, 0 attempted twice

# full app, API up and no worker running
uploaded 4 asset(s)
metadataExtraction  active 0  waiting 4  completed 1
thumbnailGeneration active 0  waiting 0  completed 1
assets without thumbnails yet: 4/4
...start the microservices worker...
thumbnails: 4/4
APP LEVEL PERSISTENCE PASS
```

The `/api/queues` view that the UI reads is served entirely from these counts:

```
thumbnailGeneration   {"active":0,"completed":5,"failed":0,"delayed":0,"waiting":0}
metadataExtraction    {"active":0,"completed":5,"failed":0,"delayed":0,"waiting":0}
faceDetection         {"active":0,"completed":5,"failed":0,"delayed":0,"waiting":0}
```

Evidence from the run (Immich `/api/queues`):

```
thumbnailGeneration      {"completed":2,"failed":0,"waiting":0}
metadataExtraction       {"completed":1,"failed":0}
backgroundTask           {"completed":9,"failed":0}
library                  {"completed":2,"failed":0}
…
```

and the files the jobs produced:

```
media/thumbs/<user>/9c/e1/9ce120be-…_thumbnail.webp     736 B
media/thumbs/<user>/9c/e1/9ce120be-…_preview.jpeg     22486 B
media/upload/<user>/9c/e1/9ce120be-….jpg              11258 B
```

The asset then reports `thumbhash: true`. `smartSearch`/`faceDetection` log
machine-learning failures (`http://immich-machine-learning:3003` unreachable),
which is expected here and unrelated to the queue.

Reproduce: `node immich-queue-test.mjs` against a running server
(`immich-queue-test.mjs`, `immich-queue-test` signs up, uploads and waits).

---

## Patches the fork needs (all small, all found by running it)

| # | File | Why |
| --- | --- | --- |
| 1 | `server/src/repositories/job.repository.ts` | `Queue`/`Worker` from BullMQ → `LocalQueue`/`LocalWorker`; `getQueue()` return type |
| 2 | `server/src/app.module.ts` | `BullModule.forRoot/registerQueue` → `LocalQueueModule.forQueues(...)` |
| 3 | `server/src/dtos/env.dto.ts` | `IMMICH_MEDIA_LOCATION` validated as POSIX (`/^\//`), so **every native Windows path is rejected**; use `path.isAbsolute` |
| 4 | `server/src/main.ts` | `new Worker(workerFile)` with `C:\…` is read as a `c:` URL scheme; pass `pathToFileURL(...)` |
| 5 | `server/src/repositories/database.repository.ts` | Kysely migration `import: (filePath) => import(filePath)` fails on Windows paths |
| 6 | `@immich/sql-tools@0.6.6` (dependency) | same raw-path `import()` in `dist/index.js`; needs `pathToFileURL`. Belongs upstream |
| 7 | `server/src/middleware/websocket.adapter.ts` | Socket.IO's Redis adapter is unconditional; a local install has no Redis, so it needs the default in-memory adapter |
| 8 | `server/src/services/metadata.service.ts` | `pause()` without a guaranteed `resume()` deadlocks the metadata queue when geodata init fails; also geodata (`/build/geodata`) has to ship with the app |

Patch 8 in the first version of this spike also collapsed the microservices into
the API process, because an in-memory queue cannot cross a process boundary. The
Postgres queue removes that reason, so the patch is **reverted**: `main.ts` forks
`api` and `microservices` exactly as upstream does.

## What the spike does NOT prove

- **Repeatable (cron) jobs and rate limiting.** Not implemented. Immich v3.3.5
  creates no repeatable jobs (`grep repeat:` finds none), so nothing depends on
  them today — but a future job that does would silently never run.
- **`removeOnComplete` / retention.** Completed rows accumulate and are capped per
  queue by the app's own `clean()` calls, not by BullMQ's option semantics.
  Deduplication keys are only reserved while a job is `waiting`/`active`.
- **ML service.** Not run here; `smartSearch`/`faceDetection` jobs are marked
  completed because Immich skips them when the service is unreachable.
- **macOS and Linux.** Not executed. Linux has published VectorChord builds and
  native Valkey; macOS needs the same clang build that eluded MSVC, which Apple
  clang provides by default. Both still need a real run.

## Files

- `local queue` — `spike/.work/immich/server/src/repositories/local-queue.repository.ts`
- `garnet-lua-probe.mjs`, `bullmq-smoke.mjs` — Redis-compatible evaluation
- `immich-queue-test.mjs` — end-to-end thumbnail test
- `queue-durability-test.mjs` — crash → recover, retries, graceful release, two-worker contention
- `queue-persistence-app-test.mjs` — jobs queued with no worker running, drained when one starts
- `linux-postgres.sh` — Linux leg, still to be run (Debian WSL distro is installed)
