// Durable-queue proof: jobs are rows, so a crash does not lose them.
//
//   node queue-durability-test.mjs crash     # enqueue, start work, die without settling
//   node queue-durability-test.mjs recover   # new process: stale jobs come back and finish
//
// `crash` exits with active rows still claimed. `recover` starts a fresh worker
// and must see them re-run (attempts = 2) and complete, with no failed rows.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(new URL("./.work/immich/server/package.json", import.meta.url));
const postgres = require("postgres");

const { LocalQueue, LocalWorker } = await import("./.work/immich/server/dist/repositories/local-queue.repository.js");

const queueName = "spikeDurability";
const connection = {
  host: process.env.DB_HOSTNAME ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 54329),
  username: process.env.DB_USERNAME ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: process.env.DB_DATABASE_NAME ?? "immich",
};

const phase = process.argv[2] ?? "crash";
const sql = postgres(connection);
const queue = new LocalQueue(sql, queueName);

const rows = () =>
  sql`select id, name, status, attempts, owner is not null as claimed
        from local_queue_job where queue = ${queueName} order by created_on`;

const summary = async () => {
  const counts = await queue.getJobCounts();
  console.log("counts", JSON.stringify(counts));
  return counts;
};

if (phase === "crash") {
  await queue.obliterate();
  await queue.resume();

  const worker = new LocalWorker(
    queue,
    async (job) => {
      if (job.name === "flaky") {
        if (job.attemptsMade <= job.data.failTimes) {
          throw new Error(`flaky attempt ${job.attemptsMade}`);
        }
        return "recovered";
      }
      // A long job: still running when the process disappears.
      await sleep(60_000);
      return "never returns";
    },
    { concurrency: 2 },
  );
  void worker;

  await queue.addBulk([
    ...Array.from({ length: 4 }, (_, index) => ({ name: "crashMe", data: { index } })),
    ...Array.from({ length: 2 }, (_, index) => ({
      name: "flaky",
      data: { index, failTimes: 2 },
      options: { attempts: 3 },
    })),
  ]);

  await sleep(2500);
  const counts = await summary();
  console.table(await rows());

  const ok = counts.active === 2 && counts.waiting === 4 && counts.completed === 0;
  console.log(ok ? "CRASH PHASE PASS (2 active, 4 waiting)" : "CRASH PHASE FAIL");
  // Hard exit, exactly like a killed process: no settle, no release, no close.
  process.exit(ok ? 0 : 1);
}

if (phase === "recover") {
  const started = Date.now();
  const worker = new LocalWorker(
    queue,
    async (job) => {
      if (job.name === "flaky") {
        if (job.attemptsMade <= job.data.failTimes) {
          throw new Error(`flaky attempt ${job.attemptsMade}`);
        }
        return "recovered";
      }
      await sleep(150);
      return "thumbnailed";
    },
    { concurrency: 2 },
  );
  void worker;

  let counts = await summary();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && counts.completed < 6) {
    await sleep(500);
    counts = await queue.getJobCounts();
  }

  const detail = await rows();
  console.table(detail);

  // Only the jobs that were mid-flight when the process died should show a
  // second attempt from the crash; `flaky` retries are its own doing.
  const recovered = detail.filter((row) => row.name === "crashMe" && row.attempts >= 2);
  const flaky = detail.find((row) => row.name === "flaky");
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`completed=${counts.completed} failed=${counts.failed} active=${counts.active} waiting=${counts.waiting}`);
  console.log(`recovered after crash: ${recovered.length} job(s) with attempts >= 2`);
  console.log(`flaky retried ${flaky?.attempts ?? 0}x and ended "${flaky?.status}"`);
  console.log(`recovery took ${elapsed}s`);

  const ok =
    counts.completed === 6 &&
    counts.failed === 0 &&
    counts.active === 0 &&
    counts.waiting === 0 &&
    recovered.length === 2 &&
    flaky?.status === "completed";
  console.log(ok ? "RECOVER PHASE PASS" : "RECOVER PHASE FAIL");
  await worker.close();

  // Graceful close hands in-flight work straight back to the queue.
  await queue.obliterate();
  const slow = new LocalWorker(queue, () => sleep(60_000), { concurrency: 2 });
  await queue.addBulk([
    { name: "graceful", data: { index: 1 } },
    { name: "graceful", data: { index: 2 } },
  ]);
  await sleep(1000);
  const before = await queue.getJobCounts();
  await slow.close();
  const after = await queue.getJobCounts();
  console.log(`graceful close: active ${before.active} -> ${after.active}, waiting ${after.waiting}`);
  const graceful = after.active === 0 && after.waiting === 2;
  console.log(graceful ? "GRACEFUL CLOSE PASS" : "GRACEFUL CLOSE FAIL");

  await queue.obliterate();
  await sql.end({ timeout: 5 });
  process.exit(ok && graceful ? 0 : 1);
}

// Two workers on one queue: row-level claiming must hand each job to exactly
// one of them, with no duplicate runs.
if (phase === "contend") {
  await queue.obliterate();
  await queue.resume();

  const second = new LocalQueue(sql, queueName);
  const work = (label) => async () => {
    await sleep(400);
    return { label };
  };
  const first = new LocalWorker(queue, work("a"), { concurrency: 2 });
  const other = new LocalWorker(second, work("b"), { concurrency: 2 });
  void first;
  void other;

  await queue.addBulk(Array.from({ length: 8 }, (_, index) => ({ name: "contend", data: { index } })));

  const deadline = Date.now() + 30_000;
  let counts = await queue.getJobCounts();
  while (Date.now() < deadline && counts.completed < 8) {
    await sleep(200);
    counts = await queue.getJobCounts();
  }

  const detail = await sql`select attempts, returnvalue from local_queue_job where queue = ${queueName}`;
  const byWorker = {};
  for (const row of detail) {
    const label = row.returnvalue?.label ?? "?";
    byWorker[label] = (byWorker[label] ?? 0) + 1;
  }

  console.log(`completed=${counts.completed} failed=${counts.failed} waiting=${counts.waiting}`);
  console.log(`split by worker: ${JSON.stringify(byWorker)}`);
  console.log(`jobs attempted more than once: ${detail.filter((row) => row.attempts > 1).length}`);

  const ok =
    counts.completed === 8 &&
    counts.failed === 0 &&
    detail.every((row) => row.attempts === 1) &&
    Object.keys(byWorker).length === 2;
  console.log(ok ? "CONTEND PHASE PASS" : "CONTEND PHASE FAIL");

  await queue.obliterate();
  await sql.end({ timeout: 5 });
  process.exit(ok ? 0 : 1);
}
