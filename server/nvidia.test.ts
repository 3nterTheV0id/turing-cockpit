// NVIDIA free endpoints, against mocks of the NGC catalog search and integrate.api.nvidia.com
// (names and ids from the real lists, 26 Sept 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.COCKPIT_DB = ":memory:";
delete process.env.NVIDIA_API_KEY;

const res = (name: string, publisher: string, general: string[] = ["Chat"]) => ({
  resourceType: "ENDPOINT",
  name,
  displayName: name,
  description: `${name} description`,
  dateCreated: "2026-09-15T19:47:58.961Z",
  labels: [
    { key: "general", values: general },
    { key: "nimType", values: ["Free Endpoint"], unresolvedValues: ["nim_type_preview"] },
    { key: "publisher", values: [publisher], unresolvedValues: [publisher] },
  ],
});
// The real "Free Endpoint" list contains speech and video endpoints too; only models in /v1/models count.
const FREE = [
  res("glm-5-3", "z-ai", ["Reasoning", "Chat", "Tool Use"]),
  res("deepseek-v4.1-flash", "deepseek-ai", ["Multimodal MOE", "Vision Language Model"]),
  res("gemma-4-31b-it", "google"),
  res("riva-translate-4b-instruct-v1_1", "nvidia", ["Translation"]),
  res("llama-3_1-nemotron-safety-guard-8b-v3", "nvidia", ["Safety"]),
  res("nemotron-3-embed-1b", "nvidia", ["Embedding", "Retrieval"]),
  res("magpie-tts-zeroshot", "nvidia", ["Text-to-Speech"]), // not in /v1/models: left out
  res("synthetic-video-detector", "nvidia", ["Video"]), // not in /v1/models: left out
];
const API_IDS = [
  "z-ai/glm-5.3",
  "deepseek-ai/deepseek-v4.1-flash",
  "google/gemma-4-31b-it",
  "nvidia/riva-translate-4b-instruct-v1.1",
  "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
  "nvidia/nemotron-3-embed-1b",
  "nvidia/ai-synthetic-video-detector",
  "01-ai/yi-large", // listed in /v1/models, but not a free endpoint: left out
];
const calls: { host: string; path: string; auth?: string; body?: Record<string, unknown> }[] = [];

const mock = createServer((req, resp) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const u = new URL(req.url!, "http://x");
    const body = data ? JSON.parse(data) : undefined;
    calls.push({ host: u.pathname.split("/")[1], path: u.pathname + u.search, auth: req.headers.authorization, body });
    const json = (o: unknown, s = 200) => {
      resp.writeHead(s, { "content-type": "application/json" });
      resp.end(JSON.stringify(o));
    };
    if (u.pathname === "/ngc/search") {
      const q = JSON.parse(u.searchParams.get("q") ?? "{}");
      assert.deepEqual(q.filters, [{ field: "nimType", value: "nim_type_preview" }]);
      return json({ resultTotal: 38, results: [{ groupValue: "_scored", resources: FREE.slice(0, 2) }, { groupValue: "ENDPOINT", resources: FREE }] });
    }
    if (u.pathname === "/nv/v1/models") return json({ object: "list", data: API_IDS.map((id) => ({ id, object: "model", owned_by: id.split("/")[0] })) });
    if (u.pathname === "/nv/v1/chat/completions") {
      if (body.model === "google/gemma-4-31b-it") return json({ status: 404, title: "Not Found", detail: "Function not found for account" }, 404);
      return json({ id: "chatcmpl-1", model: body.model, choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
    }
    if (u.pathname === "/nv/v1/embeddings") return json({ data: [{ embedding: [0.1] }], model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } });
    // OpenRouter mock (for the catalog)
    if (u.pathname === "/or/v1/models") {
      return json({
        data: [
          { id: "google/gemma-4-31b-it", name: "Google: Gemma 4 31B", canonical_slug: "google/gemma-4-31b-it-20260402", pricing: { prompt: "0.0000001", completion: "0.0000003" }, architecture: { output_modalities: ["text"] } },
          { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", pricing: { prompt: "0.0000006", completion: "0.000002" }, architecture: { output_modalities: ["text"] }, benchmarks: { artificial_analysis: { intelligence_index: 44.2, coding_index: 61, agentic_index: 40 } } },
          { id: "openai/gpt-4o-mini", name: "GPT-4o mini", pricing: { prompt: "0.00000015", completion: "0.0000006" }, architecture: { output_modalities: ["text"] } },
        ],
      });
    }
    json({ error: "unknown " + u.pathname }, 404);
  });
});
await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
process.env.NGC_SEARCH_URL = `${base}/ngc/search`;
process.env.NVIDIA_UPSTREAM = `${base}/nv/v1`;
process.env.OPENROUTER_UPSTREAM = `${base}/or/v1`;
test.after(() => {
  mock.closeAllConnections();
  mock.close();
});

test("nvKey and matchFree map catalog names to API ids", async () => {
  const { nvKey, matchFree } = await import("./nvidia.ts");
  assert.equal(nvKey("glm-5-3"), nvKey("z-ai/glm-5.3"));
  assert.equal(nvKey("riva-translate-4b-instruct-v1_1"), nvKey("nvidia/riva-translate-4b-instruct-v1.1"));
  assert.notEqual(nvKey("glm-5-3"), nvKey("z-ai/glm-5.3-flash"));
  const out = matchFree(FREE, API_IDS);
  assert.deepEqual(
    out.map((m) => m.id),
    ["deepseek-ai/deepseek-v4.1-flash", "google/gemma-4-31b-it", "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", "nvidia/nemotron-3-embed-1b", "nvidia/riva-translate-4b-instruct-v1.1", "z-ai/glm-5.3"],
  );
  assert.equal(out.find((m) => m.id === "nvidia/nemotron-3-embed-1b")?.embedding, true);
  assert.equal(out.find((m) => m.id === "z-ai/glm-5.3")?.url, "https://build.nvidia.com/z-ai/glm-5-3");
});

test("without NVIDIA_API_KEY nothing shows and the proxy is closed", async () => {
  const { app } = await import("./app.ts");
  await app.request("/api/turing/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tiers: [{ name: "basic", models: [{ id: "google/gemma-4-31b-it-20260402" }, { id: "openai/gpt-4o-mini" }] }] }) });
  const cat = (await (await app.request("/api/catalog")).json()) as { models: { source: string }[]; meta: { nvidia: { enabled: boolean } } };
  assert.equal(cat.meta.nvidia.enabled, false);
  assert.equal(cat.models.filter((m) => m.source === "nvidia").length, 0);
  const r = await app.request("/api/nvidia/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }) });
  assert.equal(r.status, 404);
  assert.equal(calls.filter((c) => c.host === "ngc").length, 0);
});

test("with NVIDIA_API_KEY: free models, badge on Turing rows, proxy with the NVIDIA key, test call", async () => {
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const { app } = await import("./app.ts");
  type Row = { source: string; slug: string; apiId: string | null; label: string; priceOut: number | null; nvidiaAlt: { id: string } | null; availability: { label: string; state: string }; categories: string[]; benchmarks: { intelligence?: number } | null; usageAll: { requests: number; cost: number } };
  const load = async () => (await (await app.request("/api/catalog?refresh=1")).json()) as { models: Row[]; meta: { nvidia: { enabled: boolean; count: number; freeTotal: number; error: string | null } } };
  let cat = await load();
  assert.equal(cat.meta.nvidia.enabled, true);
  assert.equal(cat.meta.nvidia.count, 6);
  assert.equal(cat.meta.nvidia.freeTotal, 38);
  assert.equal(cat.meta.nvidia.error, null);
  const nv = cat.models.filter((m) => m.source === "nvidia");
  assert.equal(nv.length, 6);
  const glm = nv.find((m) => m.apiId === "z-ai/glm-5.3")!;
  assert.equal(glm.slug, "nvidia:z-ai/glm-5.3");
  assert.equal(glm.priceOut, 0);
  assert.equal(glm.availability.label, "Free · NVIDIA");
  assert.equal(glm.benchmarks?.intelligence, 44.2); // from the same model on OpenRouter
  assert.ok(glm.categories.includes("Reasoning"));
  assert.ok(nv.find((m) => m.apiId === "nvidia/nemotron-3-embed-1b")!.categories.includes("Embedding"));
  // The Turing row of Gemma 4 knows that the model is also free on NVIDIA.
  const turingGemma = cat.models.find((m) => m.slug === "google/gemma-4-31b-it-20260402")!;
  assert.equal(turingGemma.nvidiaAlt?.id, "google/gemma-4-31b-it");
  assert.equal(cat.models.find((m) => m.slug === "openai/gpt-4o-mini")!.nvidiaAlt, null);
  // Only the free list is used: the NVIDIA key goes to /v1/models, the NGC search needs no key.
  assert.equal(calls.find((c) => c.path === "/nv/v1/models")?.auth, "Bearer nvapi-test");

  // Proxy: the OpenRouter key from course code is replaced by the NVIDIA key; no OpenRouter usage field.
  let r = await app.request("/api/nvidia/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-or-v1-course" },
    body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 200);
  const up = calls.filter((c) => c.path === "/nv/v1/chat/completions").at(-1)!;
  assert.equal(up.auth, "Bearer nvapi-test");
  assert.equal(up.body?.usage, undefined);
  // An own NVIDIA key in the request is kept.
  r = await app.request("/api/nvidia/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nvapi-own" }, body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }) });
  assert.equal(calls.filter((c) => c.path === "/nv/v1/chat/completions").at(-1)!.auth, "Bearer nvapi-own");
  // GET models through the proxy works too.
  r = await app.request("/api/nvidia/v1/models");
  assert.equal(r.status, 200);

  cat = await load();
  const glm2 = cat.models.find((m) => m.apiId === "z-ai/glm-5.3")!;
  assert.equal(glm2.usageAll.requests, 2);
  assert.equal(glm2.usageAll.cost, 0);
  const usage = (await (await app.request("/api/usage?days=all")).json()) as { nvidiaRequests: number; recent: { model: string; provider: string; cost: number }[] };
  assert.equal(usage.nvidiaRequests, 2);
  assert.equal(usage.recent[0].model, "nim:z-ai/glm-5.3");
  assert.equal(usage.recent[0].provider, "NVIDIA");
  assert.equal(usage.recent[0].cost, 0);

  // Test calls
  let t = (await (await app.request("/api/nvidia/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "nvidia/nemotron-3-embed-1b" }) })).json()) as { result: { verdict: string } };
  assert.equal(t.result.verdict, "ok");
  assert.equal(calls.at(-1)?.path, "/nv/v1/embeddings");
  assert.equal(calls.at(-1)?.body?.input_type, "query");
  t = (await (await app.request("/api/nvidia/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "google/gemma-4-31b-it" }) })).json()) as { result: { verdict: string } };
  assert.equal(t.result.verdict, "no-endpoints");
  cat = await load();
  const gemma = cat.models.find((m) => m.apiId === "google/gemma-4-31b-it")!;
  assert.equal(gemma.availability.state, "unavailable");
  const bad = await app.request("/api/nvidia/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "01-ai/yi-large" }) });
  assert.equal(bad.status, 404); // not a free endpoint
});

test("a failed NGC search keeps the last list and reports the error", async () => {
  process.env.NVIDIA_API_KEY = "nvapi-test";
  const { loadNvidiaFree } = await import("./nvidia.ts");
  const saved = process.env.NGC_SEARCH_URL;
  process.env.NGC_SEARCH_URL = `${base}/ngc/missing`;
  const s = await loadNvidiaFree(true);
  assert.equal(s?.models.length, 6);
  assert.match(s?.error ?? "", /404/);
  process.env.NGC_SEARCH_URL = saved;
});
