// Availability checks against a mock OpenRouter that answers like the real API (shapes checked in Sept 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.COCKPIT_DB = ":memory:";

// ---------- mock OpenRouter ----------
type Ep = Record<string, unknown>;
const ep = (tag: string, extra: Ep = {}): Ep => ({
  name: `${tag} | x`,
  provider_name: tag.split("/")[0].toUpperCase(),
  tag,
  status: 0,
  quantization: "fp8",
  context_length: 128000,
  max_completion_tokens: 16000,
  pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
  supported_parameters: ["tools", "max_tokens"],
  uptime_last_5m: 100,
  uptime_last_30m: 99.5,
  uptime_last_1d: 98.25,
  latency_last_30m: null,
  throughput_last_30m: null,
  supports_implicit_caching: true,
  ...extra,
});
const ENDPOINTS: Record<string, { id: string; name: string; endpoints: Ep[] }> = {
  "openai/gpt-4o-mini": { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o-mini", endpoints: [ep("azure"), ep("openai", { status: -2, latency_last_30m: { p50: 850 }, throughput_last_30m: { p50: 72.5 } })] },
  "anthropic/claude-3.5-haiku": { id: "anthropic/claude-3.5-haiku", name: "Anthropic: Claude 3.5 Haiku", endpoints: [] },
  "~anthropic/claude-sonnet-latest": { id: "~anthropic/claude-sonnet-latest", name: "Anthropic: Claude Sonnet Latest", endpoints: [] },
  "x-ai/grok-4.5": { id: "x-ai/grok-4.5", name: "xAI: Grok 4.5", endpoints: [ep("xai", { status: -2 }), ep("xai/fast", { status: -3 })] },
  "hidden/unlisted-model": { id: "hidden/unlisted-model", name: "Hidden: Unlisted", endpoints: [ep("hidden")] },
  "openai/text-embedding-3-small": { id: "openai/text-embedding-3-small", name: "Embed", endpoints: [ep("openai")] },
  "blocked/model": { id: "blocked/model", name: "Blocked", endpoints: [ep("blocked")] },
  "thinking/model": { id: "thinking/model", name: "Thinking", endpoints: [ep("think")] },
};
const LIST = [
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o-mini", pricing: { prompt: "0.00000015", completion: "0.0000006" }, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, benchmarks: { artificial_analysis: { intelligence_index: 21.5, coding_index: 11.4, agentic_index: null } } },
  { id: "~anthropic/claude-sonnet-latest", name: "Claude Sonnet Latest", pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { output_modalities: ["text"] } },
  { id: "x-ai/grok-4.5", name: "xAI: Grok 4.5", pricing: { prompt: "0.000003", completion: "0.000015" }, architecture: { output_modalities: ["text"] }, reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["high", "low"] } },
  { id: "openai/text-embedding-3-small", name: "Embed", pricing: { prompt: "0.00000002", completion: "0" }, architecture: { output_modalities: ["embeddings"] } },
  { id: "blocked/model", name: "Blocked", pricing: { prompt: "0.000001", completion: "0.000001" }, architecture: { output_modalities: ["text"] } },
  { id: "thinking/model", name: "Thinking", pricing: { prompt: "0.000001", completion: "0.00001" }, architecture: { output_modalities: ["text"] }, reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["high", "medium", "low", "none"] } },
];
const calls: { path: string; model?: string; auth?: string; body?: Record<string, unknown> }[] = [];
// The key may use these (guardrails). The mock returns only text models without output_modalities=all, like the real API.
let userModels = ["openai/gpt-4o-mini", "x-ai/grok-4.5", "blocked/model", "thinking/model", "openai/text-embedding-3-small"];

const upstream = createServer((req, res) => {
  let data = "";
  req.on("data", (d) => (data += d));
  req.on("end", () => {
    const u = new URL(req.url!, "http://x");
    const p = decodeURIComponent(u.pathname).replace(/^\/api\/v1/, "");
    const json = (o: unknown, s = 200) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const body = data ? JSON.parse(data) : {};
    calls.push({ path: p + u.search, model: body.model, auth: req.headers.authorization, body });
    const epm = p.match(/^\/models\/(.+)\/endpoints$/);
    if (epm) {
      const d = ENDPOINTS[epm[1]];
      return d ? json({ data: { ...d, description: "d", architecture: { output_modalities: ["text"] } } }) : json({ error: { message: "Not Found", code: 404 } }, 404);
    }
    if (p === "/models") return json({ data: LIST });
    if (p === "/models/user") {
      if (!req.headers.authorization) return json({ error: { message: "Unauthorized", code: 401 } }, 401);
      const all = u.searchParams.get("output_modalities") === "all";
      const rows = LIST.filter((m) => userModels.includes(m.id) && (all || m.architecture.output_modalities.includes("text")));
      return json({ data: rows });
    }
    if (p === "/chat/completions" || p === "/embeddings") {
      const m = body.model as string;
      if (req.headers.authorization === "Bearer sk-bad") return json({ error: { message: "User not found.", code: 401 } }, 401);
      if (m === "xai/grok-4.5") return json({ error: { message: "xai/grok-4.5 is not a valid model ID", code: 400 } }, 400);
      if (m === "x-ai/grok-4.5" && body.reasoning?.effort === "none") return json({ error: { message: "Reasoning is mandatory for this model", code: 400 } }, 400);
      if (m === "blocked/model") return json({ error: { message: "This model is not allowed for this key", code: 403 } }, 403);
      if (m === "anthropic/claude-3.5-haiku") return json({ error: { message: "No endpoints found for anthropic/claude-3.5-haiku.", code: 404 } }, 404);
      if (m === "busy/model") return json({ error: { message: "Rate limit exceeded", code: 429 } }, 429);
      if (m === "weird/model") return json({ error: { message: "Provider returned error", code: 502 } }); // 200 with error object
      if (m === "small/model" && body.max_tokens < 128) return json({ error: { message: "max_tokens must be at least 128 for this model", code: 400 } }, 400);
      if (p === "/embeddings") return json({ data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1, cost: 0.00000002 } });
      return json({ id: "gen-1", choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 12, completion_tokens: 1, cost: 0.00001 } });
    }
    json({ error: "unknown" }, 404);
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OPENROUTER_UPSTREAM = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/api/v1`;
test.after(() => {
  upstream.closeAllConnections();
  upstream.close();
});

const target = (slug: string, orId: string | null, kind: "chat" | "embedding" | "skip" = "chat", extra = {}) => ({ slug, orId, fallbacks: [slug], kind, estCost: 0, ...extra });

test("free check reads the endpoints API and keeps provider metrics", async () => {
  const { freeCheckOne } = await import("./availability.ts");
  const ok = await freeCheckOne(target("openai/gpt-4o-mini", "openai/gpt-4o-mini"));
  assert.equal(ok.state, "ok");
  assert.equal(ok.providers, 2);
  assert.equal(ok.healthy, 1);
  assert.equal(ok.endpoints?.length, 2);
  const az = ok.endpoints![0];
  assert.equal(az.slug, "azure");
  assert.equal(az.priceIn, 1);
  assert.equal(az.priceOut, 2);
  assert.equal(az.uptime30m, 99.5);
  assert.equal(az.quantization, "fp8");
  assert.equal(az.latency30m, null);
  const oa = ok.endpoints![1];
  assert.equal(oa.status, -2);
  assert.equal(oa.latency30m, 0.85); // p50 850 ms -> 0.85 s
  assert.equal(oa.throughput30m, 72.5);
  assert.equal((await freeCheckOne(target("anthropic/claude-3.5-haiku", null))).state, "retired");
  assert.equal((await freeCheckOne(target("anthropic/claude-sonnet-latest", "~anthropic/claude-sonnet-latest"))).state, "router");
  assert.equal((await freeCheckOne(target("x-ai/grok-4.5", "x-ai/grok-4.5"))).state, "down");
  assert.equal((await freeCheckOne(target("nobody/knows", null))).state, "missing");
  const hidden = await freeCheckOne({ slug: "hidden-alias/unlisted-model", orId: null, fallbacks: ["hidden-alias/unlisted-model", "hidden/unlisted-model"] });
  assert.equal(hidden.state, "ok");
  assert.equal(hidden.id, "hidden/unlisted-model");
  assert.equal(hidden.model?.name, "Hidden: Unlisted");
});

test("key model list: union with output_modalities=all, non-text flag", async () => {
  const { fetchKeyModels } = await import("./availability.ts");
  const k = await fetchKeyModels("sk-test");
  assert.ok(k);
  assert.ok(k.ids.includes("openai/text-embedding-3-small")); // only in the output_modalities=all answer
  assert.equal(k.nonText, true);
  assert.ok(calls.some((c) => c.path === "/models/user?output_modalities=all"));
});

test("test call: reasoning off, Turing slug first, errors are classified", async () => {
  const { pingOne } = await import("./availability.ts");
  const ok = await pingOne(target("openai/gpt-4o-mini", "openai/gpt-4o-mini"), "sk-test");
  assert.equal(ok.verdict, "ok");
  assert.equal(calls.at(-1)?.body?.max_tokens, 16);
  assert.equal(calls.at(-1)?.body?.reasoning, undefined);

  const off = await pingOne(target("thinking/model", "thinking/model", "chat", { reasoning: { effort: "none" } }), "sk-test");
  assert.equal(off.verdict, "ok");
  assert.deepEqual(calls.at(-1)?.body?.reasoning, { effort: "none" });

  // Turing slug unknown, OpenRouter id refuses effort "none", then works without it.
  const alias = await pingOne(target("xai/grok-4.5", "x-ai/grok-4.5", "chat", { reasoning: { effort: "none" } }), "sk-test");
  assert.equal(alias.verdict, "ok");
  assert.equal(alias.works, "x-ai/grok-4.5");
  assert.equal(calls.at(-1)?.body?.reasoning, undefined);
  assert.match(alias.message, /use x-ai\/grok-4.5/);

  assert.equal((await pingOne(target("small/model", null), "sk-test")).verdict, "ok"); // second try with 256 tokens
  assert.equal(calls.at(-1)?.body?.max_tokens, 256);
  assert.equal((await pingOne(target("blocked/model", "blocked/model"), "sk-test")).verdict, "blocked");
  assert.equal((await pingOne(target("anthropic/claude-3.5-haiku", null), "sk-test")).verdict, "no-endpoints");
  assert.equal((await pingOne(target("busy/model", null), "sk-test")).verdict, "transient");
  assert.equal((await pingOne(target("weird/model", null), "sk-test")).verdict, "transient");
  assert.equal((await pingOne(target("openai/gpt-4o-mini", null), "sk-bad")).verdict, "auth");
  const emb = await pingOne(target("openai/text-embedding-3-small", null, "embedding"), "sk-test");
  assert.equal(emb.verdict, "ok");
  assert.equal(calls.at(-1)?.path, "/embeddings");
  assert.equal((await pingOne(target("openai/gpt-image", null, "skip"), "sk-test")).verdict, "skipped");
});

test("testPlan keeps reasoning off and estimates the cost", async () => {
  const { testPlan } = await import("./catalog.ts");
  const none = testPlan("a/b", { id: "a/b", name: "b", pricing: { prompt: "0.000001", completion: "0.00001" }, reasoning: { supported_efforts: ["high", "none"], default_enabled: true } }, ["Chat"]);
  assert.deepEqual(none.reasoning, { effort: "none" });
  assert.ok(none.estCost < 0.001);
  assert.equal(none.costNote, undefined);
  const forced = testPlan("g/flash", { id: "g/flash", name: "f", pricing: { prompt: "0.00000075", completion: "0.00000375" }, reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["high", "medium", "low"] } }, ["Chat"]);
  assert.deepEqual(forced.reasoning, { effort: "low" });
  assert.ok(forced.estCost > 0.003); // about 1,000 reasoning tokens
  assert.match(forced.costNote ?? "", /always reasons/);
  const research = testPlan("perplexity/sonar-deep-research", { id: "p", name: "p", pricing: { prompt: "0.000002", completion: "0.000008", web_search: "0.005" } }, ["Chat"]);
  assert.match(research.costNote ?? "", /search the web/);
  assert.equal(testPlan("openai/gpt-image", { id: "i", name: "i" }, ["Image gen"]).kind, "skip");
  assert.equal(testPlan("openai/emb", { id: "e", name: "e", pricing: { prompt: "0.00000002" } }, ["Embedding"]).kind, "embedding");
});

test("decideAvailability: free checks only", async () => {
  const { decideAvailability } = await import("./availability.ts");
  const now = Date.now();
  const free = (state: string) => ({ id: "a/b", state, providers: 2, healthy: 2, at: now }) as never;
  const key = (ids: string[], nonText = false) => ({ ids, at: now, nonText });
  const base = { slug: "a/b", orId: "a/b", listed: true, chatModel: true, now };

  assert.equal(decideAvailability({ ...base, free: free("ok") }).label, "2 providers");
  assert.equal(decideAvailability({ ...base, free: free("retired"), keyModels: key(["a/b"]) }).label, "Retired");
  assert.equal(decideAvailability({ ...base, free: free("ok"), keyModels: key(["c/d"]) }).label, "Not for your key");
  assert.equal(decideAvailability({ ...base, free: free("ok"), keyModels: key(["a/b"]) }).state, "available");
  // Variants: the key list may name only the base model.
  assert.equal(decideAvailability({ ...base, orId: "a/b:batch", free: free("ok"), keyModels: key(["a/b"]) }).state, "available");
  // Routers are in the key list too (checked with a real Turing key), so a missing router is not allowed.
  assert.equal(decideAvailability({ ...base, orId: "~a/b", free: free("router"), keyModels: key(["c/d"]) }).label, "Not for your key");
  // An embedding model: a text-only key list says nothing about it.
  assert.equal(decideAvailability({ ...base, chatModel: false, free: free("ok"), keyModels: key(["c/d"]) }).label, "Not in key list");
  assert.equal(decideAvailability({ ...base, chatModel: false, free: free("ok"), keyModels: key(["c/d"]) }).state, "degraded"); // not greyed out
  assert.equal(decideAvailability({ ...base, chatModel: false, free: free("ok"), keyModels: key(["c/d"], true) }).state, "unavailable");
  assert.equal(decideAvailability({ ...base, chatModel: false, free: free("ok"), keyModels: key(["a/b"]) }).state, "available");
  assert.equal(decideAvailability({ ...base, free: free("down") }).state, "degraded");
  assert.equal(decideAvailability({ ...base, free: { ...(free("error") as object), error: "fetch failed" } as never }).label, "Check failed");
  assert.equal(decideAvailability({ ...base, orId: null, listed: false }).state, "unknown");
});

test("full flow: sync, free check, catalog, single test call", async () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const { app } = await import("./app.ts");
  const sync = (models: string[]) =>
    app.request("/api/turing/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tiers: [
          { name: "basic", models: models.slice(0, 2).map((id) => ({ id })) },
          { name: "advanced", models: models.slice(2).map((id) => ({ id })) },
        ],
        learner: { tier: "basic", usage: 1, limit_amount: 10 },
      }),
    });
  const list = ["openai/gpt-4o-mini", "anthropic/claude-3.5-haiku", "xai/grok-4.5", "anthropic/claude-sonnet-latest", "blocked/model"];
  const first = (await (await sync(list)).json()) as { added: string[] };
  assert.deepEqual(first.added, []);

  const waitJob = async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await (await app.request("/api/availability")).json()) as { job: { finishedAt: number | null } | null; keyModelsCount: number | null };
      if (s.job && s.job.finishedAt) return s;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("job did not finish");
  };
  let r = await app.request("/api/availability/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 202);
  const st = await waitJob();
  assert.equal(st.keyModelsCount, 5);

  type M = { slug: string; available: boolean; inMyTier: boolean; availability: { state: string; label: string }; providers: { slug: string }[]; orStatus: string; name: string; isNew: boolean; benchmarks: { intelligence?: number; coding?: number; source: string } | null; test: { possible: boolean; estCost: number; note: string | null }; lastTest: { verdict: string; text: string } | null };
  const cat = async () => new Map(((await (await app.request("/api/catalog")).json()) as { models: M[] }).models.map((m) => [m.slug, m]));
  let m = await cat();
  assert.equal(m.get("openai/gpt-4o-mini")?.availability.label, "1 provider");
  assert.deepEqual(m.get("openai/gpt-4o-mini")?.providers.map((p) => p.slug), ["azure", "openai"]);
  assert.equal(m.get("anthropic/claude-3.5-haiku")?.availability.label, "Retired");
  assert.equal(m.get("anthropic/claude-3.5-haiku")?.name, "Anthropic: Claude 3.5 Haiku");
  // The router is not in the key list: not allowed. Advanced models in the key list are not greyed out.
  assert.equal(m.get("anthropic/claude-sonnet-latest")?.availability.label, "Not for your key");
  assert.equal(m.get("xai/grok-4.5")?.available, true);
  assert.equal(m.get("xai/grok-4.5")?.inMyTier, false);
  // Benchmarks from the OpenRouter model list, without AA_API_KEY.
  assert.equal(m.get("openai/gpt-4o-mini")?.benchmarks?.intelligence, 21.5);
  assert.match(m.get("openai/gpt-4o-mini")?.benchmarks?.source ?? "", /OpenRouter/);
  assert.match(m.get("xai/grok-4.5")?.test.note ?? "", /always reasons/);

  // There is no "test all" any more.
  r = await app.request("/api/availability/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "ping" }) });
  const beforeCalls = calls.filter((c) => c.path === "/chat/completions").length;
  await waitJob();
  assert.equal(calls.filter((c) => c.path === "/chat/completions").length, beforeCalls);

  // Single test call: synchronous answer, stored, does not change the state.
  r = await app.request("/api/availability/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "blocked/model" }) });
  assert.equal(r.status, 200);
  const t = (await r.json()) as { result: { verdict: string }; text: string };
  assert.equal(t.result.verdict, "blocked");
  assert.match(t.text, /failed \(403\)/);
  m = await cat();
  assert.equal(m.get("blocked/model")?.lastTest?.verdict, "blocked");
  assert.equal(m.get("blocked/model")?.availability.state, "available"); // the key list allows it

  r = await app.request("/api/availability/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "nope/nope" }) });
  assert.equal(r.status, 404);

  // New model in the next sync: "new", and a free check at once.
  const second = (await (await sync([...list, "openai/text-embedding-3-small"])).json()) as { added: string[] };
  assert.deepEqual(second.added, ["openai/text-embedding-3-small"]);
  await waitJob();
  m = await cat();
  assert.equal(m.get("openai/text-embedding-3-small")?.isNew, true);
  assert.equal(m.get("openai/text-embedding-3-small")?.availability.state, "available");

  // Manual link
  r = await app.request("/api/models/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "anthropic/claude-3.5-haiku", orId: "openai/gpt-4o-mini" }) });
  assert.equal(r.status, 200);
  await waitJob();
  m = await cat();
  assert.equal(m.get("anthropic/claude-3.5-haiku")?.orStatus, "listed");
});

test("test call without key answers 400", async () => {
  const { app } = await import("./app.ts");
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const r = await app.request("/api/availability/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "openai/gpt-4o-mini" }) });
  assert.equal(r.status, 400);
  process.env.OPENROUTER_API_KEY = saved;
});
