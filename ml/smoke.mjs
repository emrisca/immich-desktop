// Functional check against a running service: the same multipart request Immich
// sends, and the answer has to make sense — an image of a red square must sit
// closer to "a red square" than to "a blue circle", or the pipeline is wrong.
import sharp from "sharp";

const URL = process.env.ML_URL ?? "http://127.0.0.1:3003";

const ping = await fetch(`${URL}/ping`);
console.log("ping", ping.status);

const png = await sharp({
  create: { width: 320, height: 320, channels: 3, background: { r: 220, g: 30, b: 30 } },
})
  .png()
  .toBuffer();

async function visual(buffer) {
  const form = new FormData();
  form.append("entries", JSON.stringify({ clip: { visual: { modelName: "clip" } } }));
  form.append("image", new Blob([new Uint8Array(buffer)]), "square.png");
  const response = await fetch(`${URL}/predict`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`visual ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  return { vector: JSON.parse(body.clip), width: body.imageWidth, height: body.imageHeight };
}

async function textual(text) {
  const form = new FormData();
  form.append("entries", JSON.stringify({ clip: { textual: { modelName: "clip" } } }));
  form.append("text", text);
  const response = await fetch(`${URL}/predict`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`text ${response.status}: ${await response.text()}`);
  }
  return JSON.parse((await response.json()).clip);
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

const image = await visual(png);
console.log("image dims", image.width, image.height, "vector", image.vector.length);

const red = await textual("a red square");
const blue = await textual("a blue circle");

const closer = dot(image.vector, red);
const farther = dot(image.vector, blue);
console.log("red", closer.toFixed(3), "blue", farther.toFixed(3));

if (image.vector.length !== 512) {
  throw new Error(`expected 512 dimensions, got ${image.vector.length}`);
}
if (image.width !== 320 || image.height !== 320) {
  throw new Error(`expected 320x320, got ${image.width}x${image.height}`);
}
if (closer <= farther) {
  throw new Error("the red square matched the wrong description");
}
console.log("ok");
