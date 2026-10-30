import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
// The Mac's stylesheet or the Windows one, decided by the build; see `vite.config.ts`.
import "@look";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
