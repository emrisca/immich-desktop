// M0 spike C: prove a real Immich job runs with no Redis.
// Signs up, uploads a JPEG, waits for the thumbnail job to complete.
// Usage: node immich-queue-test.mjs [baseUrl] [mediaDir]
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:2283";
// Beside this script, so the probe runs from any checkout and any user's home.
const mediaDir = process.argv[3] ?? new URL("./.work/media", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const require = createRequire(new URL("./.work/immich/server/package.json", import.meta.url));
const sharp = require("sharp");

const email = "spike@local.test";
const password = "Spike1234!";

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// 1. account
const signup = await api("/api/auth/admin-sign-up", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, name: "Spike" }),
});
console.log("signup", signup.status);
// v3 returns the user only; a token comes from login.
const auth = await api("/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const token = auth.body?.accessToken;
console.log("auth", auth.status, token ? "token ok" : JSON.stringify(auth.body).slice(0, 200));
if (!token) process.exit(2);
const authHeader = { authorization: `Bearer ${token}` };

// 2. a real image, so sharp has something to thumbnail
const seed = Math.floor(Math.random() * 200);
const jpeg = await sharp({
  create: {
    width: 1400 + seed,
    height: 1000 + seed,
    channels: 3,
    background: { r: 40 + seed, g: 90, b: 160 },
  },
})
  .jpeg({ quality: 90 })
  .toBuffer();
console.log("jpeg bytes", jpeg.length);

// 3. upload
const form = new FormData();
const now = new Date().toISOString();
form.append("assetData", new Blob([jpeg], { type: "image/jpeg" }), "spike.jpg");
form.append("deviceAssetId", `spike-${Date.now()}`);
form.append("deviceId", "spike-device");
form.append("fileCreatedAt", now);
form.append("fileModifiedAt", now);

const upload = await api("/api/assets", { method: "POST", headers: authHeader, body: form });
const asset = Array.isArray(upload.body) ? upload.body[0] : upload.body;
console.log("upload", upload.status, asset?.id ?? JSON.stringify(upload.body).slice(0, 300));
if (!asset?.id) process.exit(3);

// 4. wait for the thumbnail file the job writes
const thumbsRoot = join(mediaDir, "thumbs");
const deadline = Date.now() + 60_000;
let found = [];
while (Date.now() < deadline) {
  if (existsSync(thumbsRoot)) {
    found = readdirSync(thumbsRoot, { recursive: true })
      .map(String)
      .filter((file) => file.includes(asset.id));
    if (found.some((file) => statSync(join(thumbsRoot, file)).size > 0)) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const detail = await api(`/api/assets/${asset.id}`, { headers: authHeader });
console.log("thumbs", found.length, found.slice(0, 4));
console.log("asset status", detail.status, "thumbhash:", Boolean(detail.body?.thumbhash));
console.log(found.length > 0 ? "RESULT PASS" : "RESULT FAIL");
process.exit(found.length > 0 ? 0 : 1);
