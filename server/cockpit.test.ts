import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

process.env.COCKPIT_DB = ":memory:";

test("matchKey aligns OpenRouter and Artificial Analysis names", async () => {
  const { matchKey } = await import("./catalog.ts");
  assert.equal(matchKey("anthropic/claude-sonnet-4.5"), matchKey("claude-4-5-sonnet"));
  assert.equal(matchKey("openai/gpt-4o-mini-2024-07-18"), matchKey("GPT-4o mini"));
  assert.equal(matchKey("deepseek/deepseek-r1:free"), matchKey("DeepSeek R1 (Reasoning)"));
  assert.notEqual(matchKey("openai/gpt-4o"), matchKey("gpt-4o-mini"));
});

test("looseKey drops size words", async () => {
  const { matchKey, looseKey } = await import("./catalog.ts");
  assert.equal(looseKey(matchKey("qwen/qwen3-coder")), looseKey(matchKey("qwen3-coder-480b-a35b")));
  assert.notEqual(looseKey(matchKey("qwen/qwen3-coder")), looseKey(matchKey("qwen3-235b-a22b")));
});

test("paramsFromName reads sizes and ignores version numbers", async () => {
  const { paramsFromName } = await import("./catalog.ts");
  assert.equal(paramsFromName("meta-llama/Llama-3.3-70B-Instruct"), "70B");
  assert.equal(paramsFromName("qwen/qwen3-235b-a22b"), "235B");
  assert.equal(paramsFromName("anthropic/claude-haiku-4.5"), null);
  assert.equal(paramsFromName("openai/gpt-4o"), null);
});

test("resolveOpenRouter handles aliases", async () => {
  const { resolveOpenRouter } = await import("./catalog.ts");
  const mk = (id: string) => ({ id, name: id });
  const ids = ["~anthropic/claude-sonnet-latest", "x-ai/grok-4.5", "deepseek/deepseek-v4-flash", "openai/gpt-4o", "cohere/rerank-4-pro", "cohere/rerank-4-fast",
    "google/gemini-3.7-flash", "google/gemini-3.7-flash:batch", "google/gemma-4-31b-it", "meta/shared-name", "other/shared-name"];
  const byId = new Map<string, { id: string; name: string }>(ids.map((i) => [i, mk(i)]));
  byId.set("google/gemma-4-31b-it-20260402", mk("google/gemma-4-31b-it")); // canonical slug entry
  assert.equal(resolveOpenRouter("anthropic/claude-sonnet-latest", byId)?.id, "~anthropic/claude-sonnet-latest");
  assert.equal(resolveOpenRouter("xai/grok-4.5", byId)?.id, "x-ai/grok-4.5");
  assert.equal(resolveOpenRouter("deepseek/deepseek-v4-flash-0423", byId)?.id, "deepseek/deepseek-v4-flash");
  assert.equal(resolveOpenRouter("rerank/rerank-4-pro", byId)?.id, "cohere/rerank-4-pro");
  assert.equal(resolveOpenRouter("rerank/rerank-4-fast", byId)?.id, "cohere/rerank-4-fast");
  assert.equal(resolveOpenRouter("google/gemini-3.7-flash-batch", byId)?.id, "google/gemini-3.7-flash:batch");
  assert.equal(resolveOpenRouter("google/gemma-4-31b-it-20260402", byId)?.id, "google/gemma-4-31b-it");
  assert.equal(resolveOpenRouter("anthropic/claude-3.5-haiku", byId), undefined);
  assert.equal(resolveOpenRouter("x/shared-name", byId), undefined); // two providers: no guess
});

test("buildIdIndex keeps normal variants", async () => {
  const { buildIdIndex, resolveOpenRouter } = await import("./catalog.ts");
  const models = [
    { id: "openai/gpt-4o-mini", canonical_slug: "openai/gpt-4o-mini", name: "a" },
    { id: "openai/gpt-4o-mini:batch", canonical_slug: "openai/gpt-4o-mini", name: "b" },
    { id: "google/gemma-4-31b-it:free", canonical_slug: "google/gemma-4-31b-it-20260402", name: "c" },
    { id: "google/gemma-4-31b-it", canonical_slug: "google/gemma-4-31b-it-20260402", name: "d" },
    { id: "deepseek/deepseek-v4-flash", canonical_slug: "deepseek/deepseek-v4-flash-20260423", name: "e" },
  ];
  const idx = buildIdIndex(models);
  assert.equal(idx.get("openai/gpt-4o-mini")?.id, "openai/gpt-4o-mini");
  assert.equal(resolveOpenRouter("google/gemma-4-31b-it-20260402", idx)?.id, "google/gemma-4-31b-it");
  assert.equal(resolveOpenRouter("deepseek/deepseek-v4-flash-0423", idx)?.id, "deepseek/deepseek-v4-flash");
});

test("categorize", async () => {
  const { categorize } = await import("./catalog.ts");
  const m = { id: "x", name: "x", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] };
  assert.deepEqual(categorize(m, "google/gemini-2.5-pro"), ["Reasoning", "Vision", "Chat"]);
  assert.deepEqual(categorize(undefined, "openai/text-embedding-3-small"), ["Embedding"]);
  assert.deepEqual(categorize({ id: "e", name: "e", architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] } }, "qwen/qwen3-embedding-8b"), ["Embedding"]);
  assert.deepEqual(categorize(undefined, "openai/whisper-large-v3-turbo"), ["Audio"]);
  assert.ok(categorize(undefined, "qwen/qwen3-coder").includes("Coding"));
});

test("learner and tier normalization", async () => {
  const { normalizeLearner, normalizeTiers } = await import("./turing.ts");
  const l = normalizeLearner({ key_name: "k", usage: "1.5", limit_amount: 20, tier: "Advanced", daily_usage: [{ date: "2026-09-20", amount: 0.4 }] });
  assert.equal(l?.usage, 1.5);
  assert.equal(l?.limit, 20);
  assert.equal(l?.tier, "advanced");
  assert.equal(l?.dailyUsage?.length, 1);
  assert.deepEqual(normalizeLearner({ daily_usage: { "2026-09-01": 2 } })?.dailyUsage, [{ date: "2026-09-01", amount: 2 }]);
  const t = normalizeTiers([{ name: "basic", models: [{ id: "a/b", label: "B" }, "c/d"] }]);
  assert.equal(t[0].models.length, 2);
});

test("SSE parser keeps the last usage chunk", async () => {
  const { extractFromSSE } = await import("./proxy.ts");
  const sse = [
    'data: {"id":"gen-1","model":"openai/gpt-4o","choices":[{"delta":{"content":"Hi"}}]}',
    ": OPENROUTER PROCESSING",
    'data: {"id":"gen-1","model":"openai/gpt-4o","provider":"OpenAI","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.0001,"prompt_tokens_details":{"cached_tokens":4}}}',
    "data: [DONE]",
  ].join("\n");
  const c = extractFromSSE(sse);
  assert.equal(c.id, "gen-1");
  assert.equal(c.provider, "OpenAI");
  assert.equal(c.usage?.prompt_tokens_details?.cached_tokens, 4);
});

test("proxy forwards, logs JSON and streamed requests, and serves usage", async () => {
  const seen: { auth?: string; body?: Record<string, unknown> }[] = [];
  const upstream = createServer((req, res) => {
    let data = "";
    req.on("data", (d) => (data += d));
    req.on("end", () => {
      const body = data ? JSON.parse(data) : {};
      seen.push({ auth: req.headers.authorization, body });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"gen-s","model":"anthropic/claude-haiku-4.5","choices":[{"delta":{"content":"a"}}]}\n\n');
        setTimeout(() => {
          res.write('data: {"id":"gen-s","model":"anthropic/claude-haiku-4.5","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0002}}\n\ndata: [DONE]\n\n');
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-j", model: "openai/gpt-4o-mini", provider: "OpenAI", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.00001 } }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const port = (upstream.address() as { port: number }).port;
  process.env.OPENROUTER_UPSTREAM = `http://127.0.0.1:${port}`;

  const { Hono } = await import("hono");
  const { proxy } = await import("./proxy.ts");
  const { getUsage } = await import("./usage.ts");
  const app = new Hono();
  app.all("/api/v1/*", (c) => proxy(c));

  const r1 = await app.request("/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 200);
  assert.equal(((await r1.json()) as { id: string }).id, "gen-j");
  assert.equal(seen[0].auth, "Bearer sk-test");
  assert.deepEqual(seen[0].body?.usage, { include: true });

  const r2 = await app.request("/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "anthropic/claude-haiku-4.5", stream: true, messages: [] }),
  });
  const text = await r2.text();
  assert.ok(text.includes("[DONE]"));

  const u = getUsage(null);
  assert.equal(u.totals.requests, 2);
  assert.equal(u.byModel.length, 2);
  assert.ok(Math.abs((u.totals.cost as number) - 0.00021) < 1e-9);
  upstream.closeAllConnections();
  upstream.close();
});

test("API rejects requests from other web sites", async () => {
  const { app, allowedOrigin } = await import("./app.ts");
  assert.ok(allowedOrigin(undefined));
  assert.ok(allowedOrigin("chrome-extension://abcdef"));
  assert.ok(allowedOrigin("http://localhost:5173"));
  assert.ok(allowedOrigin("http://127.0.0.1:8787"));
  assert.ok(!allowedOrigin("https://evil.example"));
  assert.ok(!allowedOrigin("http://localhost.evil.example"));
  assert.ok(!allowedOrigin("null"));

  // A simple text/plain POST needs no CORS preflight, so the server itself must refuse it.
  const evil = await app.request("/api/v1/chat/completions", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "text/plain" },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [] }),
  });
  assert.equal(evil.status, 403);
  const evilSync = await app.request("/api/turing/sync", {
    method: "POST",
    headers: { origin: "https://evil.example", "content-type": "text/plain" },
    body: JSON.stringify({ tiers: [{ name: "basic", models: ["evil/model"] }] }),
  });
  assert.equal(evilSync.status, 403);

  const ext = await app.request("/api/turing/sync", {
    method: "POST",
    headers: { origin: "chrome-extension://abcdef", "content-type": "application/json" },
    body: JSON.stringify({ tiers: [{ name: "basic", models: [{ id: "test/sync-model" }] }] }),
  });
  assert.equal(ext.status, 200);
  assert.equal(ext.headers.get("access-control-allow-origin"), "chrome-extension://abcdef");
  const status = (await (await app.request("/api/status")).json()) as { tiers: { name: string }[] };
  assert.equal(status.tiers[0].name, "basic");
});

test("benchmark override answers 400 for a bad body", async () => {
  const { app } = await import("./app.ts");
  const r = await app.request("/api/benchmarks/override", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
  assert.equal(r.status, 400);
  const ok = await app.request("/api/benchmarks/override", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "a/b", aaSlug: null }) });
  assert.equal(ok.status, 200);
});

test("proxy drops headers that fetch() cannot send (Expect) and local cookies", async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "gen-h", model: "test/header-model", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  process.env.OPENROUTER_UPSTREAM = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const { app } = await import("./app.ts");
  const r = await app.request("/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-test",
      expect: "100-continue", // curl sends this for bodies > 1 MB
      cookie: "session=secret",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({ model: "test/header-model", messages: [{ role: "user", content: "x".repeat(2_000_000) }] }),
  });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer sk-test");
  assert.equal(seen[0].cookie, undefined);
  assert.equal(seen[0].origin, undefined);
  assert.equal(seen[0].expect, undefined);
  upstream.closeAllConnections();
  upstream.close();
});

test("catalog does not count usage of one model under two rows", async () => {
  const { kvSet, saveRequest } = await import("./db.ts");
  const { buildCatalog } = await import("./catalog.ts");
  kvSet("or:models", [
    { id: "zz/flash", canonical_slug: "zz/flash", name: "Flash", pricing: { prompt: "0.000001", completion: "0.000002" } },
    { id: "zz/flash:batch", canonical_slug: "zz/flash", name: "Flash batch", pricing: { prompt: "0.0000005", completion: "0.000001" } },
    { id: "zz/mini", name: "Mini", pricing: { prompt: "0.000001", completion: "0.000002" } },
  ]);
  kvSet("turing:tiers", [{ name: "basic", models: [{ id: "zz/flash" }, { id: "zz/flash-batch" }, { id: "zz/mini" }] }]);
  const now = Date.now();
  saveRequest({ id: "u1", ts: now, model: "zz/flash", cost: 1 });
  saveRequest({ id: "u2", ts: now, model: "zz/flash:batch", cost: 0.5 });
  saveRequest({ id: "u3", ts: now, model: "zz/mini-2026-01-01", cost: 0.25 }); // dated variant of a listed model
  const { models } = await buildCatalog();
  const by = new Map(models.map((m) => [m.slug, m]));
  assert.equal(by.get("zz/flash")?.usageAll.requests, 1);
  assert.equal(by.get("zz/flash")?.usageAll.cost, 1);
  assert.equal(by.get("zz/flash-batch")?.usageAll.requests, 1);
  assert.equal(by.get("zz/flash-batch")?.usageAll.cost, 0.5);
  assert.equal(by.get("zz/mini")?.usageAll.requests, 1);
});
