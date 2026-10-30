import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The Tauri shell points its `devUrl` at this exact port, so it is pinned.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    // A Rust build writes multi-hundred-megabyte artifacts into `src-tauri`, and
    // the dev server died once when a rebuild replaced one mid-scan.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
  },
});
