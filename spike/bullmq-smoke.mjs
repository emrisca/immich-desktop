// M0 spike B: does a Redis-compatible server carry a real BullMQ queue?
// Usage: node bullmq-smoke.mjs <host> <port>
// Exits 0 only if every job is added, processed and marked completed.
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? 6389);

const connection = { host, port, maxRetriesPerRequest: null };
const seen = [];
const name = `m0-${Date.now()}`;

const queue = new Queue(name, { connection });
const worker = new Worker(
  name,
  async (job) => {
    seen.push(job.data.n);
    return { doubled: job.data.n * 2 };
  },
  { connection, concurrency: 3 },
);

worker.on("failed", (job, err) => {
  console.error("job failed", job?.id, err.message);
});

const jobs = await queue.addBulk(
  Array.from({ length: 12 }, (_, n) => ({
    name: "thumb",
    data: { n },
    opts: { attempts: 1 },
  })),
);

const deadline = Date.now() + 20_000;
let counts = { completed: 0, failed: 0 };
while (Date.now() < deadline) {
  counts = await queue.getJobCounts("completed", "failed", "active", "wait");
  if (counts.completed === jobs.length || counts.failed > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}

const sample = await queue.getJob(jobs[0].id);
console.log("counts", counts);
console.log("processed", seen.length, "sample returnvalue", sample?.returnvalue);
console.log(
  counts.completed === jobs.length && seen.length === jobs.length
    ? "RESULT PASS"
    : "RESULT FAIL",
);

await worker.close();
await queue.obliterate({ force: true }).catch(() => {});
await queue.close();
process.exit(counts.completed === jobs.length ? 0 : 1);
