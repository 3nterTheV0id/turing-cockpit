// NVIDIA build (build.nvidia.com): free hosted model endpoints. Active only when NVIDIA_API_KEY is set.
//
// Which models are free? build.nvidia.com marks them "Free Endpoint". The page reads this from the public NGC
// catalog search (filter nimType = nim_type_preview). The cockpit reads the same search, and keeps only the models
// that the OpenAI-compatible API (integrate.api.nvidia.com/v1/models) also lists. Checked 26 Sept 2026:
// 38 free endpoints, of which the chat and embedding models are in /v1/models. Speech, video and other
// endpoints use other APIs and are left out.
//
// One key (NVIDIA_API_KEY) works for all models. The proxy at /api/nvidia/v1 adds it to each request.
import { kvGet, kvSet } from "./db.ts";
import type { ProxyTarget } from "./proxy.ts";
import type { PingResult } from "./availability.ts";

export const NVIDIA_TTL = 6 * 60 * 60 * 1000;
export const nvidiaKey = () => process.env.NVIDIA_API_KEY || undefined;
export const nvidiaEnabled = () => !!nvidiaKey();
export const nvidiaBase = () => process.env.NVIDIA_UPSTREAM ?? "https://integrate.api.nvidia.com/v1";
const ngcSearchUrl = () => process.env.NGC_SEARCH_URL ?? "https://api.ngc.nvidia.com/v2/search/catalog/resources/ENDPOINT";

export const NVIDIA: ProxyTarget = {
  name: "NVIDIA",
  prefix: /^\/api\/nvidia\/v1/,
  base: nvidiaBase,
  // An NVIDIA key in the request wins. Any other key (for example the OpenRouter key in course code) is replaced.
  auth: (incoming) => (incoming && /^Bearer\s+nvapi-/i.test(incoming) ? incoming : nvidiaKey() ? `Bearer ${nvidiaKey()}` : incoming),
  addUsageAccounting: false,
  modelPrefix: "nim:",
  provider: "NVIDIA",
  freeCost: true,
};

export interface NvidiaModel {
  id: string; // API model id, e.g. "z-ai/glm-5.3"
  name: string; // display name on build.nvidia.com
  catalogName: string; // NGC resource name, e.g. "glm-5-3"
  publisher: string;
  description: string;
  tags: string[]; // e.g. Reasoning, Chat, Tool Use, Embedding
  url: string; // model page on build.nvidia.com
  created: string | null;
  embedding: boolean;
}
export interface NvidiaState {
  models: NvidiaModel[];
  freeTotal: number; // all free endpoints (also speech, video, ...)
  at: number;
  error: string | null;
}

// "glm-5-3" and "glm-5.3", "v1_1" and "v1.1" give the same key.
export function nvKey(s: string): string {
  const raw = s.toLowerCase().replace(/^[^/]+\//, "").replace(/_/g, ".").split(/[^a-z0-9.]+/).filter(Boolean);
  const toks: string[] = [];
  for (const t of raw) {
    const prev = toks[toks.length - 1];
    if (/^\d{1,2}$/.test(t) && prev !== undefined && /^\d{1,2}(\.\d{1,2})*$/.test(prev)) toks[toks.length - 1] = `${prev}.${t}`;
    else toks.push(t);
  }
  return toks.join("-");
}

interface NgcResource {
  name?: string;
  displayName?: string;
  description?: string;
  dateCreated?: string;
  labels?: { key: string; values?: string[]; unresolvedValues?: string[] }[];
}

// Matches the free catalog entries to API ids.
export function matchFree(resources: NgcResource[], apiIds: string[]): NvidiaModel[] {
  const byKey = new Map<string, string[]>();
  for (const id of apiIds) {
    const k = nvKey(id);
    byKey.set(k, [...(byKey.get(k) ?? []), id]);
  }
  const out: NvidiaModel[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    if (!r.name) continue;
    const label = (key: string) => r.labels?.find((l) => l.key === key);
    const publisher = label("publisher")?.unresolvedValues?.[0] ?? label("publisher")?.values?.[0] ?? "";
    const exact = publisher ? `${publisher}/${r.name}` : "";
    const cands = byKey.get(nvKey(r.name)) ?? [];
    // Prefer the id with the same publisher; a single hit under another publisher is accepted too.
    const id = apiIds.includes(exact) ? exact : cands.find((c) => c.startsWith(`${publisher}/`)) ?? (cands.length === 1 ? cands[0] : undefined);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const tags = label("general")?.values ?? [];
    out.push({
      id,
      name: r.displayName || r.name,
      catalogName: r.name,
      publisher,
      description: r.description ?? "",
      tags,
      url: `https://build.nvidia.com/${publisher || id.split("/")[0]}/${r.name}`,
      created: r.dateCreated ?? null,
      embedding: /embed/i.test(id) || tags.some((t) => /embedding/i.test(t)),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

export const getNvidiaState = () => kvGet<NvidiaState>("nv:free")?.value ?? null;

export async function loadNvidiaFree(force = false): Promise<NvidiaState | null> {
  if (!nvidiaEnabled()) return null;
  const cached = getNvidiaState();
  if (!force && cached && Date.now() - cached.at < (cached.error ? 10 * 60 * 1000 : NVIDIA_TTL)) return cached;
  try {
    const q = encodeURIComponent(JSON.stringify({ query: "", page: 0, pageSize: 200, filters: [{ field: "nimType", value: "nim_type_preview" }] }));
    const [search, models] = await Promise.all([
      fetchJson(`${ngcSearchUrl()}?q=${q}`) as Promise<{ results?: { groupValue?: string; resources?: NgcResource[] }[]; resultTotal?: number }>,
      fetchJson(`${nvidiaBase()}/models`, { authorization: `Bearer ${nvidiaKey()}` }) as Promise<{ data?: { id: string }[] }>,
    ]);
    const groups = search.results ?? [];
    const resources = (groups.find((g) => g.groupValue === "ENDPOINT") ?? groups[groups.length - 1])?.resources ?? [];
    const state: NvidiaState = {
      models: matchFree(resources, (models.data ?? []).map((m) => m.id)),
      freeTotal: search.resultTotal ?? resources.length,
      at: Date.now(),
      error: null,
    };
    kvSet("nv:free", state);
    return state;
  } catch (e) {
    const state: NvidiaState = { models: cached?.models ?? [], freeTotal: cached?.freeTotal ?? 0, at: Date.now(), error: (e as Error).message };
    kvSet("nv:free", state);
    return state;
  }
}

// ---------- test call (free, but it counts against the NVIDIA rate limit) ----------
export const getNvidiaTests = () => kvGet<Record<string, PingResult>>("nv:ping")?.value ?? {};

export async function testNvidia(m: NvidiaModel): Promise<PingResult> {
  const started = Date.now();
  const body = m.embedding
    ? { model: m.id, input: ["ping"], input_type: "query", encoding_format: "float" }
    : { model: m.id, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 };
  let result: PingResult;
  try {
    const r = await fetch(`${nvidiaBase()}${m.embedding ? "/embeddings" : "/chat/completions"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${nvidiaKey()}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let msg = "";
    try {
      const j = JSON.parse(text) as { detail?: string; error?: { message?: string } | string; title?: string };
      msg = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.detail ?? j.title ?? "";
    } catch {
      msg = text.slice(0, 200);
    }
    result = r.ok
      ? { verdict: "ok", status: r.status, message: "Test call OK", latencyMs: Date.now() - started, cost: 0, works: m.id, tried: [m.id], at: started }
      : {
          verdict: r.status === 429 ? "transient" : r.status === 401 ? "auth" : r.status === 403 ? "blocked" : r.status === 404 ? "no-endpoints" : r.status >= 500 ? "transient" : "bad-request",
          status: r.status,
          message: msg || `HTTP ${r.status}`,
          latencyMs: Date.now() - started,
          cost: 0,
          works: null,
          tried: [m.id],
          at: started,
        };
  } catch (e) {
    result = { verdict: "transient", status: null, message: `No answer: ${(e as Error).message}`, latencyMs: null, cost: 0, works: null, tried: [m.id], at: started };
  }
  const all = getNvidiaTests();
  all[m.id] = result;
  kvSet("nv:ping", all);
  return result;
}
