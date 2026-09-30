import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSupabaseConfig, fetchTuringData, pushToCockpit } from "../extension/sync.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const anon = `eyJ${b64({ alg: "HS256" }).slice(3)}.${b64({ role: "anon", iss: "supabase" })}.sig`;
const service = `eyJ${b64({ alg: "HS256" }).slice(3)}.${b64({ role: "service_role" })}.sig`;

test("extract picks the anon key", () => {
  const js = `x="https://abcdefghijklmno.supabase.co";k="${service}";a="${anon}"`;
  assert.deepEqual(extractSupabaseConfig(js), { supabaseUrl: "https://abcdefghijklmno.supabase.co", anonKey: anon });
});

test("full sync with mocked fetch", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const res = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (u === "https://api-usage-tracker.turingcollege.com/") return res('<script type="module" crossorigin src="/assets/index-X.js"></script>');
    if (u.endsWith("/assets/index-X.js")) return res(`const u="https://abcdefghijklmno.supabase.co",k="${anon}"`);
    if (u.includes("/rest/v1/model_tiers")) return res([{ name: "basic", models: [{ id: "a/b", label: "B" }] }]);
    if (u.includes("/functions/v1/lookup-learner")) {
      assert.equal(JSON.parse(init.body).email, "me@x.com");
      return res({ data: { key_name: "k", usage: 1.2, limit_amount: 10, tier: "basic" } });
    }
    if (u.startsWith("http://localhost:8787/api/turing/sync")) return res({ ok: true });
    return res("no", 404);
  };
  const d = await fetchTuringData({ email: "me@x.com", config: null, fetchImpl });
  assert.equal(d.tiers.length, 1);
  assert.equal(d.learner.limit_amount, 10);
  const tierCall = calls.find((c) => c.url.includes("model_tiers"));
  assert.equal(tierCall.init.headers.apikey, anon);
  assert.deepEqual(await pushToCockpit("http://localhost:8787/", { tiers: d.tiers }, fetchImpl), { ok: true });
});
