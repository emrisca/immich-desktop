import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// The hub is drawn twice, and the two drawings cannot share a sheet: every class
// name means the same thing in both, so whichever loaded first would be restyled
// by the other. `src/styles/index.css` is the Mac's AppKit shell; `windows/app.css`
// is the look the Windows build has shipped since before it.
//
// Chosen from the platform that runs the build, because each one builds on its
// own machine — `scripts/build-mac.sh` on a Mac, `scripts/build-windows.ps1` on
// Windows — so a bundle can never carry the other platform's look.
const macLook = process.platform === "darwin";

// The Tauri shell points its `devUrl` at this exact port, so it is pinned.
export default defineConfig({
  plugins: [react()],
  // Read in `src/app/platform.ts` as `isMac`, so the Mac-only pieces and the
  // stylesheet below are decided by the same value.
  define: { __MAC_LOOK__: JSON.stringify(macLook) },
  resolve: {
    alias: {
      // Before `@`, so the prefix is not swallowed by it. One import site:
      // `src/main.tsx`.
      "@look": path(macLook ? "./src/styles/index.css" : "./src/styles/windows/app.css"),
      "@": path("./src"),
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
