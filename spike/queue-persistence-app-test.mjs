// App-level persistence check: uploads while no worker is running still get
// processed once one starts, because the jobs live in Postgres.
//
//   node queue-persistence-app-test.mjs enqueue   # needs the API up, no microservices
//   node queue-persistence-app-test.mjs verify    # needs a microservices worker up
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(new URL("./.work/immich/server/package.json", import.meta.url));
const sharp = require("sharp");
const postgres = require("postgres");

const base = process.env.IMMICH_URL ?? "http://127.0.0.1:2283";
// Beside this script, so the probe runs from any checkout and any user's home.
const mediaDir = process.argv[3] ?? new URL("./.work/media", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const phase = process.argv[2] ?? "enqueue";
const count = Number(process.env.UPLOAD_COUNT ?? 4);

const sql = postgres({
  host: process.env.DB_HOSTNAME ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 54329),
  username: process.env.DB_USERNAME ?? "postgres",
  password: process.env.DB_PASSWORD ?? "postgres",
  database: process.env.DB_DATABASE_NAME ?? "immich",
});

const email = "spike@local.test";
const password = "Spike1234!";

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function token() {
  await api("/api/auth/admin-sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Spike" }),
  });
  const auth = await api("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!auth.body?.accessToken) {
    throw new Error(`login failed: ${JSON.stringify(auth.body).slice(0, 200)}`);
  }
  return auth.body.accessToken;
}

const queueCounts = async () => {
  const rows = await sql`
    select queue,
           count(*) filter (where status = 'active')    as active,
           count(*) filter (where status = 'waiting')   as waiting,
           count(*) filter (where status = 'completed') as completed
      from local_queue_job
     where queue in ('metadataExtraction', 'thumbnailGeneration')
     group by queue order by queue`;
  return rows;
};

const thumbsFor = (id) => {
  const root = join(mediaDir, "thumbs");
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.includes(id) && statSync(join(root, file)).size > 0);
};

if (phase === "enqueue") {
  const authHeader = { authorization: `Bearer ${await token()}` };
  const assets = [];

  for (let index = 0; index < count; index++) {
    const seed = Math.floor(Math.random() * 150) + index;
    const jpeg = await sharp({
      create: {
        width: 1200 + seed,
        height: 900 + seed,
        channels: 3,
        background: { r: 20 + seed, g: 70, b: 140 },
      },
    })
      .jpeg({ quality: 88 })
      .toBuffer();

    const form = new FormData();
    const now = new Date().toISOString();
    form.append("assetData", new Blob([jpeg], { type: "image/jpeg" }), `persist-${index}.jpg`);
    form.append("deviceAssetId", `persist-${Date.now()}-${index}`);
    form.append("deviceId", "spike-device");
    form.append("fileCreatedAt", now);
    form.append("fileModifiedAt", now);

    const upload = await api("/api/assets", { method: "POST", headers: authHeader, body: form });
    const asset = Array.isArray(upload.body) ? upload.body[0] : upload.body;
    if (!asset?.id) {
      throw new Error(`upload failed: ${JSON.stringify(upload.body).slice(0, 200)}`);
    }
    assets.push(asset.id);
  }

  await sleep(1500);
  console.log("uploaded", assets.length, "asset(s)");
  console.table(await queueCounts());
  const pending = assets.filter((id) => thumbsFor(id).length === 0);
  console.log(`assets without thumbnails yet: ${pending.length}/${assets.length}`);
  console.log(JSON.stringify({ assets }));

  await sql.end({ timeout: 5 });
  process.exit(pending.length === assets.length ? 0 : 1);
}

if (phase === "verify") {
  const ids = JSON.parse(process.argv[4] ?? "[]");
  if (ids.length === 0) {
    console.log("usage: verify <mediaDir> '<json array of asset ids>'");
    console.log("no asset ids supplied — refusing to report a pass");
    process.exit(2);
  }
  const started = Date.now();
  let missing = ids;

  while (Date.now() - started < 60_000) {
    missing = ids.filter((id) => thumbsFor(id).length === 0);
    if (missing.length === 0) {
      break;
    }
    await sleep(500);
  }

  console.table(await queueCounts());
  const reran = await sql`
    select queue, name, attempts, status from local_queue_job
     where attempts > 1 order by seq desc limit 10`;
  console.log(`thumbnails: ${ids.length - missing.length}/${ids.length} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (reran.length > 0) {
    console.log("jobs that ran more than once (retried or recovered):");
    console.table(reran);
  }
  console.log(missing.length === 0 ? "APPS LEVEL PERSISTENCE PASS" : "APP LEVEL PERSISTENCE FAIL");

  await sql.end({ timeout: 5 });
  process.exit(missing.length === 0 ? 0 : 1);
}
