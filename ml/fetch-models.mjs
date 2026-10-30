// One-time model download, run on the build machine. The app ships `models/`
// and the service never touches the network: `allowRemoteModels` stays false.
import { AutoProcessor, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, env } from "@huggingface/transformers";

const MODEL = process.env.CLIP_MODEL ?? "Xenova/clip-vit-base-patch32";
// Defaults to `models/` beside this file. The macOS assembler installs the
// dependencies into `runtime/ml` instead and passes this so a rebuild reuses the
// one download rather than repeating it.
env.cacheDir =
  process.env.CLIP_MODEL_DIR ??
  new URL("./models", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
env.allowRemoteModels = true;

console.log("downloading", MODEL, "into", env.cacheDir);
await AutoTokenizer.from_pretrained(MODEL);
await AutoProcessor.from_pretrained(MODEL);
await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: "q8" });
await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "q8" });
console.log("done");
