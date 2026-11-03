import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// The hub is drawn once. `src/styles/index.css` is the Mac's AppKit shell, and
// every build wears it: the second sheet that used to sit beside it —
// `windows/app.css`, the glass look of violet aurora and blurred panes — has
// been removed, so a Windows install and a Mac install are the same window.
//
// The flag below stays even though it can no longer be false. The pieces that
// came with the Mac look (the appearance picker, the frame colour the shell
// paints, the circle window controls) read it, and one constant is easier to
// trust than three copies of `true`.
const macLook = true;

// The Tauri shell points its `devUrl` at this exact port, so it is pinned.
export default defineConfig({
  plugins: [react()],
  // Read in `src/app/platform.ts` as `isMac`, so the look's own pieces and the
  // stylesheet below are decided by the same value.
  define: { __MAC_LOOK__: JSON.stringify(macLook) },
  resolve: {
    alias: {
      // Before `@`, so the prefix is not swallowed by it. One import site:
      // `src/main.tsx`.
      "@look": path("./src/styles/index.css"),
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
