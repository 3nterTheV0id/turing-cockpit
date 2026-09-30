import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { buildCatalog, getCheckTargets, listAA, listOpenRouterIds, setBenchmarkOverride, setModelLink } from "./catalog.ts";
import { FREE_TTL, currentJob, describeTest, getFreeResults, getKeyModels, isRunning, startFreeCheck, testOne } from "./availability.ts";
import { proxy } from "./proxy.ts";
import { NVIDIA, getNvidiaState, loadNvidiaFree, nvidiaEnabled, testNvidia } from "./nvidia.ts";
import { getTuring, saveTuringSync } from "./turing.ts";
import { getUsage } from "./usage.ts";

// The Hono app (API, proxy, static UI). index.ts loads .env first and then starts the HTTP server.
// The tests import this file directly.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.PORT ?? 8787);
export const app = new Hono();

// Only the extension and the local UI may call the API.
export const allowedOrigin = (origin: string | undefined) =>
  !origin || origin.startsWith("chrome-extension://") || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

// CORS alone does not stop a web page from *sending* a simple POST (for example text/plain) to localhost.
// Without this check, any site that you open could send calls through the proxy with the key from .env
// (and spend your credit), or overwrite the synced Turing data. Requests without an Origin header
// (Python, curl, LangChain, the extension service worker) are not affected.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!allowedOrigin(origin)) {
    return c.json({ error: { message: `Cockpit: requests from ${origin} are not allowed.` } }, 403);
  }
  return next();
});

app.use(
  "/api/*",
  cors({
    origin: (origin) => (allowedOrigin(origin) ? origin : null),
  }),
);

app.get("/api/status", (c) => {
  const t = getTuring();
  return c.json({
    ok: true,
    port: PORT,
    turingSyncedAt: t.syncedAt,
    tiers: t.tiers.map((x) => ({ name: x.name, count: x.models.length, updatedAt: x.updated_at })),
    learner: t.learner,
    aaEnabled: !!process.env.AA_API_KEY,
    keyConfigured: !!process.env.OPENROUTER_API_KEY,
    nvidiaEnabled: nvidiaEnabled(),
  });
});

app.post("/api/turing/sync", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tiers?: unknown; learner?: unknown };
  const state = saveTuringSync(body);
  console.log(`[sync] ${state.tiers.map((t) => `${t.name}: ${t.models.length}`).join(", ")}${state.learner ? `, learner tier ${state.learner.tier}` : ""}`);
  if (state.added.length) {
    console.log(`[sync] new Turing models: ${state.added.join(", ")}`);
    void checkNewModels(state.added);
  }
  return c.json({ ok: true, tiers: state.tiers.length, learner: !!state.learner, added: state.added });
});

app.get("/api/catalog", async (c) => {
  try {
    return c.json(await buildCatalog({ force: c.req.query("refresh") === "1" }));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.get("/api/usage", (c) => {
  const d = c.req.query("days");
  return c.json({ ...getUsage(d && d !== "all" ? Number(d) : null), turing: getTuring().learner });
});

app.get("/api/key", async (c) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return c.json({ configured: false });
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
    return c.json({ configured: true, ...((await r.json()) as object) });
  } catch (e) {
    return c.json({ configured: true, error: (e as Error).message });
  }
});

app.get("/api/benchmarks/models", async (c) => c.json(await listAA()));
app.post("/api/benchmarks/override", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: unknown; aaSlug?: unknown } | null;
  if (!body || typeof body.slug !== "string" || !(body.aaSlug === null || typeof body.aaSlug === "string")) {
    return c.json({ error: 'Send JSON: { "slug": string, "aaSlug": string | null }' }, 400);
  }
  setBenchmarkOverride(body.slug, body.aaSlug);
  return c.json({ ok: true });
});

// ---------- availability ----------
// Automatic checks are free (key model list + provider check). A test call runs only for one model, on request.
const key = () => process.env.OPENROUTER_API_KEY || undefined;

// New Turing models: free check at once.
async function checkNewModels(slugs: string[]) {
  startFreeCheck(await getCheckTargets({ slugs }), key());
}

// Runs the free check when the last one is older than 6 hours, or when models have no result yet.
export async function autoFreeCheck(): Promise<void> {
  if (isRunning()) return;
  try {
    const targets = await getCheckTargets();
    const free = getFreeResults();
    const keyModels = getKeyModels();
    // Network errors: try again after 10 minutes, not after 6 hours.
    const stale = targets.filter((t) => {
      const f = free[t.slug];
      if (!f) return true;
      const age = Date.now() - f.at;
      // Results from an older cockpit version have no provider list: check again.
      if (!f.endpoints && (f.state === "ok" || f.state === "down")) return true;
      return age > FREE_TTL || (f.state === "error" && age > 10 * 60 * 1000);
    });
    // A key was added (or the key list is old): check again, so the key list is read.
    const keyStale = !!key() && (!keyModels || Date.now() - keyModels.at > FREE_TTL);
    if (stale.length || keyStale) startFreeCheck(keyStale ? targets : stale, key());
  } catch (e) {
    console.warn("[availability]", (e as Error).message);
  }
}

app.get("/api/availability", async (c) => {
  const free = Object.values(getFreeResults());
  const keyModels = getKeyModels();
  return c.json({
    job: currentJob(),
    keyConfigured: !!key(),
    lastFreeAt: free.length ? Math.max(...free.map((f) => f.at)) : null,
    keyModelsAt: keyModels?.at ?? null,
    keyModelsCount: keyModels?.ids.length ?? null,
  });
});

// Free check for all Turing models, or for the given slugs.
app.post("/api/availability/check", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { slugs?: unknown };
  if (isRunning()) return c.json({ error: "A check is running. Wait until it is finished.", job: currentJob() }, 409);
  const slugs = Array.isArray(body.slugs) ? body.slugs.filter((s): s is string => typeof s === "string") : undefined;
  const targets = await getCheckTargets({ slugs });
  if (!targets.length) return c.json({ error: "No models to check." }, 400);
  return c.json({ job: startFreeCheck(targets, key()) }, 202);
});

// Test call for ONE model. The answer comes when the call is finished.
const testing = new Set<string>();
app.post("/api/availability/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { slug?: unknown };
  if (typeof body.slug !== "string") return c.json({ error: 'Send JSON: { "slug": string }' }, 400);
  if (!key()) return c.json({ error: "Add OPENROUTER_API_KEY to .env and restart the server. The test call needs a key." }, 400);
  if (testing.has(body.slug)) return c.json({ error: "A test call for this model is running." }, 409);
  const [target] = await getCheckTargets({ slugs: [body.slug] });
  if (!target) return c.json({ error: "This model is not on the Turing list." }, 404);
  if (target.kind === "skip") return c.json({ error: target.skipReason ?? "This model cannot be test-called." }, 400);
  testing.add(body.slug);
  try {
    const result = await testOne(target, key()!);
    return c.json({ result, text: describeTest(result) });
  } finally {
    testing.delete(body.slug);
  }
});

// ---------- NVIDIA (free endpoints, only with NVIDIA_API_KEY) ----------
app.post("/api/nvidia/test", async (c) => {
  if (!nvidiaEnabled()) return c.json({ error: "Add NVIDIA_API_KEY to .env and restart the server." }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string") return c.json({ error: 'Send JSON: { "id": string }' }, 400);
  const state = (await loadNvidiaFree()) ?? getNvidiaState();
  const model = state?.models.find((m) => m.id === body.id);
  if (!model) return c.json({ error: "This model is not in the list of free NVIDIA endpoints." }, 404);
  if (testing.has(`nvidia:${body.id}`)) return c.json({ error: "A test call for this model is running." }, 409);
  testing.add(`nvidia:${body.id}`);
  try {
    const result = await testNvidia(model);
    return c.json({ result, text: describeTest(result) });
  } finally {
    testing.delete(`nvidia:${body.id}`);
  }
});

// Proxy for the free NVIDIA endpoints: base_url http://localhost:8787/api/nvidia/v1. The cockpit adds NVIDIA_API_KEY.
app.all("/api/nvidia/v1/*", (c) => {
  const own = /^Bearer\s+nvapi-/i.test(c.req.header("authorization") ?? "");
  if (!nvidiaEnabled() && !own) return c.json({ error: { message: "Cockpit: NVIDIA is not set up. Add NVIDIA_API_KEY to .env and restart the server." } }, 404);
  return proxy(c, NVIDIA);
});

// ---------- manual OpenRouter link ----------
app.get("/api/openrouter/ids", async (c) => c.json(await listOpenRouterIds()));
app.post("/api/models/link", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { slug?: unknown; orId?: unknown } | null;
  if (!body || typeof body.slug !== "string" || !(body.orId === null || typeof body.orId === "string")) {
    return c.json({ error: 'Send JSON: { "slug": string, "orId": string | null }' }, 400);
  }
  setModelLink(body.slug, body.orId || null);
  // The link changes the id to check: check this model again.
  const targets = await getCheckTargets({ slugs: [body.slug] });
  startFreeCheck(targets, key());
  return c.json({ ok: true });
});

// OpenRouter proxy
app.all("/api/v1/*", (c) => proxy(c));

// Static UI (after "npm run build")
const dist = resolve(root, "web", "dist");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
app.get("*", async (c) => {
  const p = c.req.path === "/" ? "/index.html" : c.req.path;
  const file = resolve(dist, "." + p);
  const target = file.startsWith(dist) && existsSync(file) ? file : resolve(dist, "index.html");
  if (!existsSync(target)) return c.text("The UI is not built. Run: npm start (or npm run dev for development).", 404);
  return new Response(await readFile(target), { headers: { "content-type": TYPES[extname(target)] ?? "application/octet-stream" } });
});
