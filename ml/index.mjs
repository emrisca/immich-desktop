// Immich's machine learning contract, answered by CLIP in JavaScript.
//
// Immich posts multipart/form-data to `/predict` with an `entries` field holding
// the request JSON plus either `image` or `text`, and expects the embedding back
// as a JSON array string (that is what its Postgres vector column is given).
// Only CLIP runs here; face recognition and OCR are turned off in the server's
// configuration, so no request for them ever arrives.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import busboy from "busboy";
import sharp from "sharp";
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from "@huggingface/transformers";

const MODEL = "Xenova/clip-vit-base-patch32";
const PORT = Number(process.env.ML_PORT ?? 3003);

// Both paths have to be absolute. Left alone, transformers resolves its local
// model directory against its own package folder, which is inside node_modules —
// that works only while the working directory happens to be this one.
// `fileURLToPath`, not `URL.pathname`: a pathname keeps `%20` for the space in
// "Immich Desktop", and the model loader then looks for a folder that is not
// there.
const MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), "models");
env.cacheDir = MODELS;
env.localModelPath = MODELS;
// Offline by design: the models ship beside this file.
env.allowRemoteModels = false;
env.allowLocalModels = true;

let towers = null;
async function load() {
  if (towers) {
    return towers;
  }
  const options = { dtype: "q8" };
  const [tokenizer, text, processor, vision] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL),
    CLIPTextModelWithProjection.from_pretrained(MODEL, options),
    AutoProcessor.from_pretrained(MODEL),
    CLIPVisionModelWithProjection.from_pretrained(MODEL, options),
  ]);
  towers = { tokenizer, text, processor, vision };
  return towers;
}

/** Unit length, because Immich compares with cosine distance. */
function normalise(vector) {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const length = Math.sqrt(sum) || 1;
  return Array.from(vector, (value) => value / length);
}

function format(vector) {
  return `[${normalise(vector).map((value) => value.toFixed(6)).join(",")}]`;
}

async function embedText(text) {
  const { tokenizer, text: model } = await load();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const output = await model(inputs);
  return format(output.text_embeds.data);
}

async function embedImage(buffer) {
  const { processor, vision } = await load();
  const image = await RawImage.fromBlob(new Blob([buffer]));
  const inputs = await processor(image);
  const output = await vision(inputs);
  return {
    embedding: format(output.image_embeds.data),
    width: image.width,
    height: image.height,
  };
}

function readMultipart(request) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const chunks = [];
    let image = null;
    const parser = busboy({ headers: request.headers });

    parser.on("field", (name, value) => {
      fields[name] = value;
    });
    parser.on("file", (_name, stream, info) => {
      const parts = [];
      stream.on("data", (chunk) => parts.push(chunk));
      stream.on("end", () => {
        image = {
          filename: info.filename,
          buffer: Buffer.concat(parts),
        };
      });
    });
    parser.on("close", () => resolve({ fields, image, chunks }));
    parser.on("error", reject);
    request.pipe(parser);
  });
}

async function predict(request, response) {
  const { fields, image } = await readMultipart(request);

  let entries;
  try {
    entries = JSON.parse(fields.entries ?? "{}");
  } catch (error) {
    return send(response, 400, { error: `entries is not JSON: ${error.message}` });
  }

  if (entries.clip?.visual) {
    if (!image?.buffer?.length) {
      return send(response, 400, { error: "visual entry needs an image" });
    }
    const result = await embedImage(image.buffer);
    // Immich reads these two to fill width/height when the file is new.
    const meta = await sharp(image.buffer).metadata();
    return send(response, 200, {
      clip: result.embedding,
      imageWidth: result.width || meta.width || 0,
      imageHeight: result.height || meta.height || 0,
    });
  }

  if (entries.clip?.textual) {
    if (typeof fields.text !== "string" || fields.text.length === 0) {
      return send(response, 400, { error: "textual entry needs text" });
    }
    return send(response, 200, { clip: await embedText(fields.text) });
  }

  // Face recognition and OCR are not implemented here: both need their own
  // detector/recogniser pipelines and models. Answering with empty results keeps
  // those jobs completing instead of failing once per asset, and is the truth —
  // no faces or text were found because nothing looked.
  if (entries["facial-recognition"]) {
    const meta = image?.buffer?.length ? await sharp(image.buffer).metadata() : {};
    return send(response, 200, {
      "facial-recognition": [],
      imageWidth: meta.width ?? 0,
      imageHeight: meta.height ?? 0,
    });
  }

  if (entries.ocr) {
    const meta = image?.buffer?.length ? await sharp(image.buffer).metadata() : {};
    return send(response, 200, {
      ocr: { text: [], box: [], boxScore: [], textScore: [] },
      imageWidth: meta.width ?? 0,
      imageHeight: meta.height ?? 0,
    });
  }

  return send(response, 400, {
    error: "only clip, facial-recognition and ocr are known here",
  });
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = http.createServer(async (request, response) => {
  const path = (request.url ?? "/").split("?")[0].replace(/\/+$/, "");
  try {
    if (path.endsWith("/ping")) {
      return send(response, 200, {});
    }
    if (path.endsWith("/predict") && request.method === "POST") {
      return await predict(request, response);
    }
    return send(response, 404, { error: "not found" });
  } catch (error) {
    // Immich retries; the message is what shows up in its log next to the job.
    console.error("predict failed:", error?.message ?? error);
    return send(response, 500, { error: error?.message ?? "predict failed" });
  }
});

// Load once at boot: the first job should not pay for it, and a broken model
// must be visible in the log rather than as a failed import.
await load().then(
  () => console.log(`clip ready on ${PORT}`),
  (error) => {
    console.error("clip model failed to load:", error?.message ?? error);
    process.exitCode = 1;
  },
);
server.listen(PORT, "127.0.0.1");
