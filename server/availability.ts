// Availability checks for the Turing models. All automatic checks are free.
//
//  1. Key model list (needs OPENROUTER_API_KEY, free): GET /api/v1/models/user returns the models that your key
//     may use. It applies the guardrails of the key. Turing College limits its keys with guardrails, so this list
//     is the real answer to "can I call this model?" (checked Sept 2026: 44 of the 59 Turing slugs).
//  2. Providers (no key, free): GET /api/v1/models/{id}/endpoints lists the providers that serve a model, with
//     status, uptime, prices and the provider slug. A model that left the OpenRouter list still has this page,
//     but with 0 providers: it is "retired" and calls to it fail.
//  3. Test call (manual, one model, costs a small amount). One request with max_tokens 16 and reasoning off
//     where the model allows it. It never runs for all models: in Sept 2026 a test call to all models cost
//     $0.77, mostly for reasoning tokens (several models reason by default, some always).
//
// The results are stored in the kv table. The catalog uses 1 and 2 to grey out models that do not work.
import { kvGet, kvSet } from "./db.ts";
import { upstreamBase } from "./proxy.ts";

export const FREE_TTL = 6 * 60 * 60 * 1000; // 6 hours

export type FreeState = "ok" | "router" | "retired" | "missing" | "down" | "error";
export interface FreeModelInfo {
  id: string;
  name?: string;
  description?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  context_length?: number;
  pricing?: Record<string, string | number | undefined>;
  supported_parameters?: string[];
  max_completion_tokens?: number | null;
}
// One provider endpoint of a model (from the OpenRouter endpoints API).
export interface ProviderInfo {
  provider: string; // "Google AI Studio"
  slug: string; // provider slug for provider.order / provider.only, e.g. "google-ai-studio/flex"
  status: number | null; // 0 = normal, negative = OpenRouter ranks it down
  quantization: string | null;
  contextLength: number | null;
  maxOutput: number | null;
  priceIn: number | null; // USD per 1M tokens
  priceOut: number | null;
  priceCacheRead: number | null;
  uptime5m: number | null; // percent
  uptime30m: number | null;
  uptime1d: number | null;
  latency30m: number | null; // seconds, when OpenRouter sends it
  throughput30m: number | null; // tokens per second, when OpenRouter sends it
  tools: boolean;
  implicitCaching: boolean;
}
export interface FreeResult {
  id: string; // the OpenRouter id that answered
  state: FreeState;
  providers: number;
  healthy: number;
  at: number;
  error?: string;
  model?: FreeModelInfo;
  endpoints?: ProviderInfo[];
}

export type PingVerdict =
  | "ok"
  | "invalid" // OpenRouter does not know the model id
  | "no-endpoints" // no provider (for your key or data policy)
  | "blocked" // 403: not allowed for this key
  | "bad-request" // 400 for another reason (for example a parameter the model does not accept)
  | "transient" // rate limit, provider error, time-out
  | "auth" // key invalid
  | "no-credit" // key limit reached
  | "skipped";
export interface PingResult {
  verdict: PingVerdict;
  status: number | null;
  message: string;
  latencyMs: number | null;
  cost: number | null;
  works: string | null; // the model id that worked (Turing slug or OpenRouter id)
  tried: string[];
  at: number;
}

export type PingKind = "chat" | "embedding" | "skip";
export interface ReasoningParam {
  effort?: string;
}
export interface CheckTarget {
  slug: string;
  orId: string | null; // resolved OpenRouter id (null: no match in the model list)
  fallbacks: string[]; // spelling variants for the endpoints API when orId is null
  kind: PingKind;
  skipReason?: string;
  reasoning?: ReasoningParam; // sent with the test call to keep reasoning off or low
  estCost: number; // expected cost of one test call, USD
  costNote?: string; // why the test call can cost more
}

export interface Job {
  kind: "free";
  total: number;
  done: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface KeyModels {
  ids: string[];
  at: number;
  nonText: boolean; // the list also contains models without text output (embeddings, images, audio)
}

// ---------- storage ----------
export const getFreeResults = () => kvGet<Record<string, FreeResult>>("avail:free")?.value ?? {};
export const getPingResults = () => kvGet<Record<string, PingResult>>("avail:ping")?.value ?? {};
export const getKeyModels = (): KeyModels | null => {
  const v = kvGet<KeyModels>("avail:keyModels")?.value;
  return v ? { ...v, nonText: !!v.nonText } : null;
};

function mergeKv<T>(key: string, add: Record<string, T>) {
  const cur = kvGet<Record<string, T>>(key)?.value ?? {};
  kvSet(key, { ...cur, ...add });
}

// ---------- helpers ----------
const fetchT = (url: string, init: RequestInit = {}, ms = 20_000) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const x = items[i++];
      await fn(x);
    }
  });
  await Promise.all(workers);
}

const endpointsUrl = (id: string) =>
  `${upstreamBase()}/models/${id
    .replace(/:.*$/, "")
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/%7E/gi, "~"))
    .join("/")}/endpoints`;

const perM = (v: unknown): number | null => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 1e6 * 10000) / 10000;
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
// latency and throughput: a number, or percentiles { p50, ... }.
const metric = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") return numOrNull((v as Record<string, unknown>).p50);
  return null;
};

export function toProviderInfo(e: Record<string, unknown>): ProviderInfo {
  const p = (e.pricing ?? {}) as Record<string, unknown>;
  const params = Array.isArray(e.supported_parameters) ? (e.supported_parameters as string[]) : [];
  const lat = metric(e.latency_last_30m);
  return {
    provider: String(e.provider_name ?? String(e.name ?? "").split("|")[0].trim()),
    slug: String(e.tag ?? String(e.provider_name ?? "").toLowerCase().replace(/\s+/g, "-")),
    status: numOrNull(e.status),
    quantization: typeof e.quantization === "string" && e.quantization !== "unknown" ? e.quantization : null,
    contextLength: numOrNull(e.context_length),
    maxOutput: numOrNull(e.max_completion_tokens),
    priceIn: perM(p.prompt),
    priceOut: perM(p.completion),
    priceCacheRead: perM(p.input_cache_read),
    uptime5m: numOrNull(e.uptime_last_5m),
    uptime30m: numOrNull(e.uptime_last_30m),
    uptime1d: numOrNull(e.uptime_last_1d),
    // OpenRouter reports latency in milliseconds when it sends it.
    latency30m: lat === null ? null : lat > 50 ? lat / 1000 : lat,
    throughput30m: metric(e.throughput_last_30m),
    tools: params.includes("tools"),
    implicitCaching: e.supports_implicit_caching === true,
  };
}

// ---------- free check ----------
export async function freeCheckOne(t: Pick<CheckTarget, "slug" | "orId" | "fallbacks">): Promise<FreeResult> {
  const now = Date.now();
  const candidates = t.orId ? [t.orId] : t.fallbacks.length ? t.fallbacks : [t.slug];
  for (const id of candidates) {
    let r: Response;
    try {
      r = await fetchT(endpointsUrl(id));
    } catch (e) {
      return { id, state: "error", providers: 0, healthy: 0, at: now, error: (e as Error).message };
    }
    if (r.status === 404) continue;
    if (!r.ok) return { id, state: "error", providers: 0, healthy: 0, at: now, error: `OpenRouter answered ${r.status}` };
    const j = (await r.json().catch(() => ({}))) as {
      data?: { id?: string; name?: string; description?: string; architecture?: FreeModelInfo["architecture"]; endpoints?: Record<string, unknown>[] };
    };
    const d = j.data ?? {};
    const eps = Array.isArray(d.endpoints) ? d.endpoints : [];
    // status 0 = normal. Negative values mean that OpenRouter ranks the provider down.
    const healthy = eps.filter((e) => e.status === undefined || e.status === 0).length;
    const router = id.startsWith("~") || (d.id ?? "").startsWith("~");
    const state: FreeState = router ? "router" : eps.length === 0 ? "retired" : healthy === 0 ? "down" : "ok";
    const e0 = (eps.find((e) => e.status === 0) ?? eps[0]) as Record<string, unknown> | undefined;
    return {
      id: id.includes(":") ? id : d.id ?? id,
      state,
      providers: eps.length,
      healthy,
      at: now,
      endpoints: eps.map(toProviderInfo),
      model: {
        id: d.id ?? id,
        name: d.name,
        description: d.description,
        architecture: d.architecture,
        context_length: e0?.context_length as number | undefined,
        pricing: e0?.pricing as FreeModelInfo["pricing"],
        supported_parameters: e0?.supported_parameters as string[] | undefined,
        max_completion_tokens: e0?.max_completion_tokens as number | null | undefined,
      },
    };
  }
  return { id: candidates[0], state: "missing", providers: 0, healthy: 0, at: now };
}

// The models that the key may use. Also asks with output_modalities=all, in case the endpoint filters like /models.
export async function fetchKeyModels(key: string): Promise<KeyModels | null> {
  const ids = new Set<string>();
  let nonText = false;
  let ok = false;
  for (const q of ["", "?output_modalities=all"]) {
    try {
      const r = await fetchT(`${upstreamBase()}/models/user${q}`, { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) continue;
      const j = (await r.json()) as { data?: { id: string; architecture?: { output_modalities?: string[] } }[] };
      if (!Array.isArray(j.data)) continue;
      ok = true;
      for (const m of j.data) {
        ids.add(m.id);
        const out = m.architecture?.output_modalities;
        if (out && out.length && !out.includes("text")) nonText = true;
      }
    } catch {
      /* optional */
    }
  }
  if (!ok || !ids.size) return null;
  const v: KeyModels = { ids: [...ids], at: Date.now(), nonText };
  kvSet("avail:keyModels", v);
  return v;
}

// ---------- test call ----------
function classify(status: number, message: string): PingVerdict {
  if (status === 401) return "auth";
  if (status === 402) return "no-credit";
  if (status === 403) return "blocked";
  if (status === 404) return "no-endpoints";
  if (status === 400 && /not a valid model|invalid model|model.*(not found|does not exist)|unknown model/i.test(message)) return "invalid";
  if (status === 400 || status === 422) return "bad-request";
  return "transient";
}

async function callOnce(
  model: string,
  kind: PingKind,
  key: string,
  opts: { maxTokens?: number; reasoning?: ReasoningParam } = {},
): Promise<Omit<PingResult, "works" | "tried" | "at">> {
  const started = Date.now();
  const isEmb = kind === "embedding";
  const body = isEmb
    ? { model, input: "ping" }
    : {
        model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: opts.maxTokens ?? 16,
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
        usage: { include: true },
      };
  let res: Response;
  try {
    res = await fetchT(
      `${upstreamBase()}${isEmb ? "/embeddings" : "/chat/completions"}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Turing Model Cockpit test call" },
        body: JSON.stringify(body),
      },
      60_000,
    );
  } catch (e) {
    return { verdict: "transient", status: null, message: `No answer: ${(e as Error).message}`, latencyMs: null, cost: null };
  }
  const text = await res.text();
  let j: { error?: { message?: string; code?: number }; usage?: { cost?: number } } = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const latencyMs = Date.now() - started;
  const cost = typeof j.usage?.cost === "number" ? j.usage.cost : null;
  // OpenRouter can answer 200 with an error object.
  const errStatus = res.ok && j.error ? Number(j.error.code) || 500 : res.status;
  if (res.ok && !j.error) return { verdict: "ok", status: res.status, message: "Test call OK", latencyMs, cost };
  const message = (j.error?.message ?? text.slice(0, 200)) || `HTTP ${errStatus}`;
  return { verdict: classify(errStatus, message), status: errStatus, message, latencyMs, cost };
}

export async function pingOne(t: CheckTarget, key: string): Promise<PingResult> {
  const at = Date.now();
  if (t.kind === "skip") {
    return { verdict: "skipped", status: null, message: t.skipReason ?? "Not tested", latencyMs: null, cost: null, works: null, tried: [], at };
  }
  const ids = [t.slug, ...(t.orId && t.orId !== t.slug ? [t.orId] : [])];
  const tried: string[] = [];
  let first: Omit<PingResult, "works" | "tried" | "at"> | null = null;
  let spent = 0;
  for (const id of ids) {
    tried.push(id);
    let r = await callOnce(id, t.kind, key, { reasoning: t.reasoning });
    spent += r.cost ?? 0;
    // The model does not accept the reasoning setting: try again without it.
    if (r.verdict === "bad-request" && t.reasoning && /reason|effort|thinking/i.test(r.message)) {
      r = await callOnce(id, t.kind, key);
      spent += r.cost ?? 0;
    }
    // Some models refuse a small token limit. Try once more with 256 tokens.
    if (r.verdict === "bad-request" && t.kind === "chat" && /token|budget|max_/i.test(r.message)) {
      r = await callOnce(id, t.kind, key, { maxTokens: 256, reasoning: t.reasoning });
      spent += r.cost ?? 0;
    }
    if (r.verdict === "ok") {
      const message = id === t.slug ? "Test call OK with the Turing slug" : `The Turing slug fails (${first?.message ?? "error"}). The OpenRouter id works: use ${id}.`;
      return { ...r, cost: spent || r.cost, message, works: id, tried, at };
    }
    first ??= r;
    // Only an unknown id is worth a second try with the other spelling.
    if (!["invalid", "no-endpoints", "bad-request"].includes(r.verdict)) break;
  }
  return { ...first!, cost: spent || null, works: null, tried, at };
}

// One test call. The result is stored at once.
export async function testOne(t: CheckTarget, key: string): Promise<PingResult> {
  const r = await pingOne(t, key);
  mergeKv("avail:ping", { [t.slug]: r });
  return r;
}

// ---------- free check job ----------
let job: Job | null = null;
export const currentJob = () => job;
export const isRunning = () => !!job && job.finishedAt === null;

export function startFreeCheck(targets: CheckTarget[], key?: string): Job | null {
  if (isRunning() || !targets.length) return null;
  const j: Job = { kind: "free", total: targets.length, done: 0, startedAt: Date.now(), finishedAt: null, error: null };
  job = j;
  void (async () => {
    const out: Record<string, FreeResult> = {};
    try {
      if (key) await fetchKeyModels(key);
      await mapLimit(targets, 6, async (t) => {
        out[t.slug] = await freeCheckOne(t);
        j.done++;
      });
    } catch (e) {
      j.error = (e as Error).message;
    } finally {
      mergeKv("avail:free", out);
      j.finishedAt = Date.now();
    }
  })();
  return j;
}

// ---------- verdict for the catalog ----------
export type AvailState = "available" | "unavailable" | "degraded" | "unknown";
export interface Availability {
  state: AvailState;
  label: string; // short text for the status column
  detail: string; // tooltip
  source: "key" | "openrouter" | "none";
  checkedAt: number | null;
}

const when = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function describeTest(p: PingResult): string {
  const cost = p.cost !== null ? `, cost $${p.cost.toFixed(6)}` : "";
  const lat = p.latencyMs ? `, ${(p.latencyMs / 1000).toFixed(1)} s` : "";
  if (p.verdict === "ok") return `Last test call ${when(p.at)}: ${p.message}${lat}${cost}.`;
  if (p.verdict === "skipped") return `No test call: ${p.message}`;
  return `Last test call ${when(p.at)} failed (${p.status ?? "no answer"}): ${p.message}${cost}. Tried: ${p.tried.join(", ")}.`;
}

// Decides from the free checks only. A test call does not change the state; it shows for a few seconds in the UI
// and in the tooltip.
export function decideAvailability(input: {
  slug: string;
  orId: string | null;
  listed: boolean; // in the OpenRouter model list
  chatModel: boolean; // text in, text out. The key list surely covers these; for audio, image, embedding and rerank models it may not.
  free?: FreeResult;
  keyModels?: KeyModels | null;
  now?: number;
}): Availability {
  const { slug, orId, listed, chatModel, free, keyModels } = input;
  const notes: string[] = [];
  const id = orId ?? free?.id ?? null;

  if (free?.state === "retired") {
    return { state: "unavailable", label: "Retired", detail: `OpenRouter check ${when(free.at)}: OpenRouter still has a page for ${free.id}, but no provider serves it. Calls fail.`, source: "openrouter", checkedAt: free.at };
  }
  if (free?.state === "missing") {
    return { state: "unavailable", label: "Not on OpenRouter", detail: `OpenRouter check ${when(free.at)}: OpenRouter does not know this slug or its spelling variants.`, source: "openrouter", checkedAt: free.at };
  }

  // The key list surely covers chat models. For other types it may leave them out (a real Turing key list has no
  // embedding, audio-transcription or image models), unless it contains non-text models.
  const inList = (x: string) => !!keyModels && (keyModels.ids.includes(x) || keyModels.ids.includes(x.replace(/:.*$/, "")));
  const covered = keyModels && listed && id && (chatModel || keyModels.nonText);
  if (keyModels && listed && id && !covered && !inList(id) && !inList(slug) && free?.state !== "error") {
    return {
      state: "degraded",
      label: "Not in key list",
      detail: `The model list of your key (OpenRouter /models/user, ${when(keyModels.at)}) does not include ${id}. That list may leave out this model type (audio, image, embedding, rerank), so the model can still work. A test call (if possible for this type) gives the answer.${free && free.providers ? ` ${free.healthy} of ${free.providers} providers serve it.` : ""}`,
      source: "key",
      checkedAt: keyModels.at,
    };
  }
  if (covered) {
    if (!inList(id) && !inList(slug)) {
      return {
        state: "unavailable",
        label: "Not for your key",
        detail: `The model list of your key (OpenRouter /models/user, ${when(keyModels.at)}) does not include ${id}. The key's guardrails (set by Turing College) or your privacy settings block it.`,
        source: "key",
        checkedAt: keyModels.at,
      };
    }
    notes.push(`Your key may use it (OpenRouter /models/user, ${when(keyModels.at)}).`);
  } else if (keyModels && listed && inList(id ?? slug)) {
    notes.push(`Your key may use it (OpenRouter /models/user, ${when(keyModels.at)}).`);
  }

  const extra = notes.length ? ` ${notes.join(" ")}` : "";
  if (free) {
    const w = `OpenRouter check ${when(free.at)}`;
    switch (free.state) {
      case "ok":
        return { state: "available", label: `${free.healthy} provider${free.healthy === 1 ? "" : "s"}`, detail: `${w}: ${free.healthy} of ${free.providers} providers serve ${free.id}. Click the label for the provider details.${extra}`, source: covered ? "key" : "openrouter", checkedAt: free.at };
      case "router":
        return { state: "available", label: "Router", detail: `${w}: ${free.id} is an OpenRouter router. It sends each call to the newest model of the family.${extra}`, source: covered ? "key" : "openrouter", checkedAt: free.at };
      case "down":
        return { state: "degraded", label: "Provider problems", detail: `${w}: OpenRouter ranks all ${free.providers} providers of ${free.id} down. Calls can fail. Click the label for the provider details.${extra}`, source: "openrouter", checkedAt: free.at };
      case "error":
        return { state: "unknown", label: "Check failed", detail: `${w} failed: ${free.error}. The cockpit tries again in 10 minutes.${extra}`, source: "none", checkedAt: free.at };
    }
  }
  if (covered) return { state: "available", label: "Allowed", detail: `Provider check not done yet.${extra}`, source: "key", checkedAt: keyModels!.at };
  return {
    state: "unknown",
    label: "Not checked",
    detail: `${listed ? "In the OpenRouter model list." : "Not in the OpenRouter model list."} Not checked yet. Click "Check availability".${extra}`,
    source: "none",
    checkedAt: null,
  };
}
