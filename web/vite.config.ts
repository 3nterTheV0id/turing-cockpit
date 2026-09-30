import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: resolve(here, "dist"), emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
});
