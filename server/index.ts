import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

// Load .env before the other modules read process.env.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));

const { app, PORT, autoFreeCheck } = await import("./app.ts");

const main = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`\nModel Cockpit     http://localhost:${PORT}`);
  console.log(`OpenRouter proxy  http://localhost:${PORT}/api/v1   (use this as base_url)\n`);
  // Free availability check (OpenRouter endpoints API, no cost): soon after the start, then every 10 minutes (it only checks models with an old or failed result).
  setTimeout(() => void autoFreeCheck(), 3000);
  setInterval(() => void autoFreeCheck(), 10 * 60 * 1000).unref();
});
main.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. The cockpit is probably running in another terminal.`);
    console.error(`Close that terminal, or set another PORT in .env (then change the address in the extension popup too).\n`);
    process.exit(1);
  }
  throw e;
});

// Also listen on the IPv6 loopback. On Windows, "localhost" resolves to ::1 first. Without this listener,
// Python clients (httpx, requests) wait about 2 seconds for each new connection before they fall back to 127.0.0.1.
// The server still accepts connections only from this computer.
const v6 = serve({ fetch: app.fetch, port: PORT, hostname: "::1" });
v6.on("error", () => {
  /* No IPv6 on this computer, or the port is taken on ::1. 127.0.0.1 still works. */
});
