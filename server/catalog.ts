// Builds the model catalog: the Turing College model list, enriched with OpenRouter data,
// Artificial Analysis benchmarks (optional) and your own usage from the proxy log.
import { db, kvGet, kvSet } from "./db.ts";
import { getTuring } from "./turing.ts";
import { upstreamBase } from "./proxy.ts";
import { buildIdIndex, nameKey, resolveWithKind, slugVariants, type MatchKind } from "./match.ts";
import { getNvidiaTests, loadNvidiaFree, nvidiaEnabled, type NvidiaModel, type NvidiaState } from "./nvidia.ts";
import {
  decideAvailability,
  describeTest,
  getFreeResults,
  getKeyModels,
  getPingResults,
  type Availability,
  type CheckTarget,
  type FreeResult,
  type PingResult,
  type PingVerdict,
  type ProviderInfo,
  type ReasoningParam,
} from "./availability.ts";

const OR_TTL = 6 * 60 * 60 * 1000; // 6 hours
const AA_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface ORModel {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  name: string;
  created?: number;
  description?: string;
  context_length?: number;
  architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, string | number | undefined>;
  top_provider?: { context_length?: number; max_completion_tokens?: number | null };
  supported_parameters?: string[];
  expiration_date?: string | null;
  // Reasoning settings of the model (OpenRouter /models, Sept 2026).
  reasoning?: { mandatory?: boolean; default_enabled?: boolean; default_effort?: string; supported_efforts?: string[] };
  // Benchmark data in the OpenRouter model list (source: Artificial Analysis). Free, no key.
  benchmarks?: { artificial_analysis?: { intelligence_index?: number | null; coding_index?: number | null; agentic_index?: number | null } };
}

export interface Benchmarks {
  source: string;
  aaSlug: string;
  aaName: string;
  aaUrl: string;
  indexVersion?: string; // version of the Intelligence Index, as the API reports it
  intelligence?: number;
  coding?: number;
  math?: number;
  agentic?: number;
  gpqa?: number;
  hle?: number;
  mmluPro?: number;
  livecodebench?: number;
  outputTps?: number;
  ttft?: number;
}

export { buildIdIndex, resolveOpenRouter, resolveWithKind, nameKey, slugVariants } from "./match.ts";

export interface CatalogModel {
  source: "turing" | "nvidia"; // Turing College list, or a free NVIDIA endpoint
  apiId: string | null; // NVIDIA rows: the model id for the API (slug is "nvidia:<id>")
  nvidiaUrl: string | null; // NVIDIA rows: model page on build.nvidia.com
  nvidiaAlt: { id: string; url: string } | null; // Turing rows: the same model is free on NVIDIA
  slug: string;
  orId: string | null; // OpenRouter id when it differs from the Turing slug
  matchKind: MatchKind | null; // how the OpenRouter model was found
  orStatus: "listed" | "unlisted" | "none"; // unlisted: only the OpenRouter endpoints API knows it
  label: string;
  name: string;
  provider: string;
  description: string;
  tiers: string[];
  inMyTier: boolean; // Turing tiers add up: "advanced" includes the "basic" models
  available: boolean; // false = the checks show that calls fail (greyed out)
  availability: Availability;
  providers: ProviderInfo[]; // from the free provider check
  lastTest: { verdict: PingVerdict; at: number; latencyMs: number | null; cost: number | null; works: string | null; text: string } | null;
  test: { possible: boolean; estCost: number; note: string | null }; // for the test call button
  expirationDate: string | null; // OpenRouter retires the model on this date
  isNew: boolean; // Turing added it in the last 14 days
  firstSeen: number | null;
  inOpenRouter: boolean;
  categories: string[];
  inputModalities: string[];
  outputModalities: string[];
  contextLength: number | null;
  maxOutput: number | null;
  params: string | null; // e.g. "70B"; null = unknown
  openWeights: boolean;
  priceIn: number | null; // USD per 1M tokens
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
  priceReasoning: number | null;
  priceRequest: number | null; // USD per request (some search and research models)
  features: { tools: boolean; structured: boolean; reasoning: boolean; caching: boolean; vision: boolean };
  created: number | null;
  benchmarks: Benchmarks | null;
  usage30d: { requests: number; cost: number; tokens: number };
  usageAll: { requests: number; cost: number; tokens: number };
}

const perMillion = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null; // OpenRouter uses -1 for "variable" router prices
  return Math.round(n * 1e6 * 10000) / 10000;
};

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  // Time limit: a hanging upstream must not block the catalog (the cached data is used instead).
  const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

export async function getOpenRouterModels(force = false): Promise<ORModel[]> {
  const cached = kvGet<ORModel[]>("or:models");
  if (!force && cached && Date.now() - cached.updatedAt < OR_TTL) return cached.value;
  try {
    // output_modalities=all also returns embedding, audio and image models.
    const j = (await fetchJson(`${upstreamBase()}/models?output_modalities=all`)) as { data: ORModel[] };
    kvSet("or:models", j.data);
    return j.data;
  } catch (e) {
    if (cached) return cached.value; // Use old data when offline.
    throw e;
  }
}

// ---------- Artificial Analysis ----------
type AARaw = Record<string, unknown>;

export interface AAStatus {
  ok: boolean;
  at: number;
  count: number;
  version: string | null;
  error: string | null;
}
export const getAAStatus = () => kvGet<AAStatus>("aa:status")?.value ?? null;

async function getAA(force = false): Promise<AARaw[]> {
  const key = process.env.AA_API_KEY;
  if (!key) return [];
  const cached = kvGet<AARaw[]>("aa:models");
  const status = getAAStatus();
  // After a failure, try again after 1 hour (the free tier allows 100 requests per day).
  const ttl = status && !status.ok ? 60 * 60 * 1000 : AA_TTL;
  const last = status?.at ?? cached?.updatedAt ?? 0;
  if (!force && Date.now() - last < ttl) return cached?.value ?? [];
  // Documented free endpoint (Sept 2026): GET /api/v2/language/models/free, header x-api-key, paged.
  // The older /api/v2/data/llms/models route is the fallback.
  const urls = [
    "https://artificialanalysis.ai/api/v2/language/models/free",
    "https://artificialanalysis.ai/api/v2/data/llms/models",
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const all: AARaw[] = [];
      let version: string | null = null;
      for (let page = 1; page <= 20; page++) {
        const j = (await fetchJson(url.includes("/free") ? `${url}?page=${page}` : url, { "x-api-key": key })) as {
          data?: AARaw[];
          models?: AARaw[];
          has_more?: boolean;
          intelligence_index_version?: string | number;
          pagination?: { has_more?: boolean; total_pages?: number };
        };
        if (j.intelligence_index_version !== undefined) version = String(j.intelligence_index_version);
        const rows = j.data ?? j.models ?? [];
        all.push(...rows);
        const more = j.has_more ?? j.pagination?.has_more ?? (j.pagination?.total_pages ? page < j.pagination.total_pages : false);
        if (!url.includes("/free") || !more || rows.length === 0) break;
      }
      if (all.length) {
        if (version) for (const r of all) r.__indexVersion = version;
        kvSet("aa:models", all);
        kvSet("aa:status", { ok: true, at: Date.now(), count: all.length, version, error: null } satisfies AAStatus);
        return all;
      }
      errors.push(`${url}: no models in the answer`);
    } catch (e) {
      errors.push((e as Error).message);
      console.warn("[aa]", (e as Error).message);
    }
  }
  kvSet("aa:status", { ok: false, at: Date.now(), count: cached?.value.length ?? 0, version: status?.version ?? null, error: errors.join(" | ") } satisfies AAStatus);
  return cached?.value ?? [];
}

const pick = (o: AARaw | undefined, ...keys: string[]): number | undefined => {
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
};

function toBenchmarks(r: AARaw): Benchmarks {
  const ev = (r.evaluations as AARaw | undefined) ?? (r.indices as AARaw | undefined) ?? r;
  const perf = (r.performance as AARaw | undefined) ?? r;
  return {
    source: "Artificial Analysis",
    aaSlug: String(r.slug ?? ""),
    aaName: String(r.name ?? ""),
    aaUrl: r.slug ? `https://artificialanalysis.ai/models/${String(r.slug)}` : "https://artificialanalysis.ai/",
    indexVersion: r.__indexVersion ? String(r.__indexVersion) : undefined,
    intelligence: pick(ev, "artificial_analysis_intelligence_index", "intelligence_index") ?? pick(r, "intelligence_index"),
    coding: pick(ev, "artificial_analysis_coding_index", "coding_index") ?? pick(r, "coding_index"),
    math: pick(ev, "artificial_analysis_math_index", "math_index"),
    agentic: pick(ev, "artificial_analysis_agentic_index", "agentic_index"),
    gpqa: pick(ev, "gpqa"),
    hle: pick(ev, "hle"),
    mmluPro: pick(ev, "mmlu_pro"),
    livecodebench: pick(ev, "livecodebench"),
    outputTps: pick(perf, "median_output_tokens_per_second", "output_tokens_per_second"),
    ttft: pick(perf, "median_time_to_first_token_seconds", "time_to_first_token_seconds"),
  };
}

const DROP = new Set(["instruct", "preview", "latest", "chat", "it", "exp", "free", "thinking", "reasoning", "non", "adaptive", "high", "low", "medium"]);

// Model names differ between sites ("claude-sonnet-4.5" vs "claude-4-5-sonnet"). Compare sorted word sets.
export function matchKey(s: string): string {
  const base = s.toLowerCase().replace(/^[^/]+\//, "").replace(/:.*$/, "").replace(/\(.*?\)/g, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const tokens = base
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !DROP.has(t))
    .filter((t) => !/^\d{4}$/.test(t) && !/^\d{6,8}$/.test(t)); // dates such as 2025 or 20250219
  return [...new Set(tokens)].sort().join("|");
}

const SIZE = /^(a?\d+(\.\d+)?[bm])$/;
// Second key without size words ("480b", "a35b"). Only used when it points to exactly one model.
export function looseKey(key: string): string {
  return key.split("|").filter((t) => !SIZE.test(t)).join("|");
}

function buildLooseIndex(rows: AARaw[]): Map<string, AARaw[]> {
  const idx = new Map<string, AARaw[]>();
  for (const r of rows) {
    for (const k of [looseKey(matchKey(String(r.slug ?? ""))), looseKey(matchKey(String(r.name ?? "")))]) {
      if (!k) continue;
      const list = idx.get(k) ?? [];
      if (!list.includes(r)) list.push(r);
      idx.set(k, list);
    }
  }
  return idx;
}

function buildAAIndex(rows: AARaw[]): Map<string, AARaw[]> {
  const idx = new Map<string, AARaw[]>();
  for (const r of rows) {
    for (const k of [matchKey(String(r.slug ?? "")), matchKey(String(r.name ?? ""))]) {
      if (!k) continue;
      const list = idx.get(k) ?? [];
      if (!list.includes(r)) list.push(r);
      idx.set(k, list);
    }
  }
  return idx;
}

function findAA(idx: Map<string, AARaw[]>, loose: Map<string, AARaw[]>, bySlug: Map<string, AARaw>, slug: string, name: string, override?: string): AARaw | null {
  if (override) return bySlug.get(override) ?? null;
  let cands = idx.get(matchKey(slug)) ?? idx.get(matchKey(name)) ?? [];
  if (!cands.length) {
    for (const k of [looseKey(matchKey(slug)), looseKey(matchKey(name))]) {
      const l = loose.get(k) ?? [];
      // Accept one model, or several variants of one model (reasoning / non-reasoning share the same name words).
      const names = new Set(l.map((r) => looseKey(matchKey(String(r.slug ?? "")))));
      if (l.length && names.size === 1) {
        cands = l;
        break;
      }
    }
  }
  if (!cands.length) return null;
  // Several variants (reasoning / non-reasoning): take the one with the highest intelligence score.
  return [...cands].sort((a, b) => (toBenchmarks(b).intelligence ?? -1) - (toBenchmarks(a).intelligence ?? -1))[0];
}

// ---------- helpers ----------
export function paramsFromName(...names: (string | null | undefined)[]): string | null {
  for (const n of names) {
    if (!n) continue;
    const m = n.toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s?([bm])(?![a-z0-9])/);
    if (m) return `${m[1]}${m[2].toUpperCase()}`;
  }
  return null;
}

export function categorize(m: ORModel | undefined, slug: string): string[] {
  const s = slug.toLowerCase();
  const inMods = m?.architecture?.input_modalities ?? [];
  const outMods = m?.architecture?.output_modalities ?? [];
  const params = m?.supported_parameters ?? [];
  const cats: string[] = [];
  if (outMods.includes("image")) cats.push("Image gen");
  if (outMods.includes("audio") || inMods.includes("audio") || /whisper|transcribe|tts/.test(s)) cats.push("Audio");
  if (outMods.includes("embeddings") || /embed/.test(s)) cats.push("Embedding");
  if (outMods.includes("rerank") || /rerank/.test(s)) cats.push("Rerank");
  if (/coder|codex|devstral|codestral|code-/.test(s)) cats.push("Coding");
  if (params.includes("reasoning") || params.includes("include_reasoning")) cats.push("Reasoning");
  if (inMods.includes("image") || inMods.includes("file")) cats.push("Vision");
  if ((!outMods.length && !cats.length) || outMods.includes("text")) {
    if (!cats.includes("Embedding") && !cats.includes("Rerank") && !/whisper|transcribe/.test(s)) cats.push("Chat");
  }
  return cats;
}

// Benchmarks: the OpenRouter model list carries Artificial Analysis indexes for many models (free, exact id, no
// name matching). The Artificial Analysis API (with AA_API_KEY) adds speed and time to first token, and fills gaps.
function mergeBenchmarks(m: ORModel | undefined, fromApi: Benchmarks | null): Benchmarks | null {
  const or = m?.benchmarks?.artificial_analysis;
  const val = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const hasOr = !!or && [or.intelligence_index, or.coding_index, or.agentic_index].some((v) => val(v) !== undefined);
  if (!hasOr) return fromApi;
  const b: Benchmarks = {
    ...(fromApi ?? { aaSlug: "", aaName: "", aaUrl: "https://artificialanalysis.ai/" }),
    source: fromApi ? "OpenRouter model data + Artificial Analysis API" : "OpenRouter model data (from Artificial Analysis)",
    intelligence: val(or!.intelligence_index) ?? fromApi?.intelligence,
    coding: val(or!.coding_index) ?? fromApi?.coding,
    agentic: val(or!.agentic_index) ?? fromApi?.agentic,
  };
  if (!fromApi) b.aaName = m!.name;
  return b;
}

function usageBySlug(sinceTs: number): Map<string, { requests: number; cost: number; tokens: number }> {
  const rows = db
    .prepare(
      "SELECT model, COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(prompt_tokens + completion_tokens),0) AS tokens FROM requests WHERE ts >= ? GROUP BY model",
    )
    .all(sinceTs) as { model: string; requests: number; cost: number; tokens: number }[];
  const map = new Map<string, { requests: number; cost: number; tokens: number }>();
  for (const r of rows) {
    // The response can name a dated variant (openai/gpt-4o-2024-08-06). Also count it under the base slug.
    map.set(r.model, { requests: r.requests, cost: r.cost, tokens: r.tokens });
  }
  return map;
}

function loadOverrides(): Record<string, string> {
  return kvGet<Record<string, string>>("aa:overrides")?.value ?? {};
}

// Manual links Turing slug -> OpenRouter id, set in the UI when the automatic match fails or is wrong.
export function loadModelLinks(): Record<string, string> {
  return kvGet<Record<string, string>>("or:links")?.value ?? {};
}
export function setModelLink(slug: string, orId: string | null): void {
  const links = loadModelLinks();
  if (orId) links[slug] = orId;
  else delete links[slug];
  kvSet("or:links", links);
}

// Turing tiers add up. Basic: all learners in the first sprint. Advanced: from the second sprint, with the basic models.
const TIER_RANK: Record<string, number> = { basic: 1, advanced: 2 };
export function tierIncludes(myTier: string | null, modelTiers: string[]): boolean {
  if (!myTier) return true;
  const mine = TIER_RANK[myTier];
  if (mine === undefined) return modelTiers.includes(myTier);
  return modelTiers.some((t) => t === myTier || (TIER_RANK[t] !== undefined && TIER_RANK[t] <= mine));
}

const NEW_FOR = 14 * 24 * 60 * 60 * 1000;

// Turns the OpenRouter endpoints answer into an ORModel, for models that are not in the OpenRouter list.
function fromFree(f: FreeResult): ORModel | undefined {
  if (!f.model?.id) return undefined;
  return {
    id: f.id,
    name: f.model.name ?? f.id,
    description: f.model.description,
    architecture: f.model.architecture,
    context_length: f.model.context_length,
    pricing: f.model.pricing,
    supported_parameters: f.model.supported_parameters,
    top_provider: { max_completion_tokens: f.model.max_completion_tokens ?? null },
  };
}

interface Entry {
  slug: string;
  label?: string;
  tiers: string[];
  m: ORModel | undefined;
  kind: MatchKind | null;
  listed: boolean;
  free?: FreeResult;
}

function collectEntries(orModels: ORModel[]): { entries: Entry[]; byId: Map<string, ORModel> } {
  const turing = getTuring();
  const byId = buildIdIndex(orModels);
  const links = loadModelLinks();
  const free = getFreeResults();
  const raw = new Map<string, { label?: string; tiers: string[] }>();
  if (turing.tiers.length) {
    for (const t of turing.tiers) {
      for (const tm of t.models) {
        const e = raw.get(tm.id) ?? { label: tm.label, tiers: [] };
        if (!e.tiers.includes(t.name)) e.tiers.push(t.name);
        e.label ??= tm.label;
        raw.set(tm.id, e);
      }
    }
  } else {
    for (const m of orModels) raw.set(m.id, { label: m.name, tiers: [] });
  }
  const entries: Entry[] = [];
  for (const [slug, e] of raw) {
    let { model: m, kind } = resolveWithKind(slug, byId, links);
    const listed = !!m;
    const f = free[slug];
    if (!m && f && f.state !== "missing" && f.state !== "error") {
      m = fromFree(f);
      kind = "endpoints";
    }
    entries.push({ slug, label: e.label, tiers: e.tiers, m, kind, listed, free: f });
  }
  return { entries, byId };
}

// How to test-call one model, and what it costs. Reasoning stays off where the model allows it:
// reasoning tokens bill as output tokens and caused most of the cost of the old "test all" button.
export function testPlan(slug: string, m: ORModel | undefined, cats: string[]): Pick<CheckTarget, "kind" | "skipReason" | "estCost" | "reasoning" | "costNote"> {
  const p = m?.pricing ?? {};
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (cats.includes("Embedding")) return { kind: "embedding", estCost: 8 * num(p.prompt) };
  if (cats.includes("Image gen")) return { kind: "skip", skipReason: "Image models are not test-called: one image can cost several cents.", estCost: 0 };
  if (cats.includes("Rerank")) return { kind: "skip", skipReason: "Rerank models use another API.", estCost: 0 };
  if (cats.includes("Audio") && !cats.includes("Chat")) return { kind: "skip", skipReason: "Audio models need an audio file.", estCost: 0 };
  const r = m?.reasoning;
  const efforts = r?.supported_efforts ?? [];
  let reasoning: ReasoningParam | undefined;
  let reasoningTokens = 0;
  if (efforts.includes("none")) reasoning = { effort: "none" };
  else if (r && (r.mandatory || r.default_enabled)) {
    // Reasoning cannot be turned off: use the lowest effort. Expect up to about 1,000 reasoning tokens.
    const low = ["minimal", "low", "medium"].find((e) => efforts.includes(e));
    if (low) reasoning = { effort: low };
    reasoningTokens = 1000;
  }
  const outPrice = num(p.completion);
  const search = /sonar|search|research/.test(slug);
  const estCost = 12 * num(p.prompt) + (16 + reasoningTokens) * Math.max(outPrice, num(p.internal_reasoning)) + num(p.request) + (search ? 5 * num(p.web_search) : 0);
  const notes: string[] = [];
  if (reasoningTokens) notes.push("This model always reasons, and reasoning tokens bill as output.");
  if (search) notes.push("Research models search the web on each call. The real cost can be much higher (often $0.10 to $1).");
  if (p.prompt !== undefined && Number(p.prompt) < 0) notes.push("Router: the price depends on the model that answers.");
  return { kind: "chat", estCost, reasoning, costNote: notes.length ? notes.join(" ") : undefined };
}

// The models to check (free check) or to test-call.
export async function getCheckTargets(opts: { slugs?: string[] } = {}): Promise<CheckTarget[]> {
  // Only the Turing list. Without a sync, the catalog shows all 600+ OpenRouter models: too many to check.
  if (!getTuring().tiers.length) return [];
  const orModels = await getOpenRouterModels().catch(() => kvGet<ORModel[]>("or:models")?.value ?? []);
  const { entries } = collectEntries(orModels);
  return entries
    .filter((e) => !opts.slugs || opts.slugs.includes(e.slug))
    .map((e) => {
      const orId = e.listed && e.m ? e.m.id : null;
      return {
        slug: e.slug,
        orId,
        fallbacks: orId ? [] : slugVariants(e.slug).filter((v) => !v.startsWith("~") || e.slug.includes("latest")),
        ...testPlan(e.slug, e.m, categorize(e.m, e.slug)),
      };
    });
}

export async function buildCatalog(opts: { force?: boolean } = {}): Promise<{
  models: CatalogModel[];
  meta: {
    orUpdatedAt: number | null;
    aaEnabled: boolean;
    aaUpdatedAt: number | null;
    aaStatus: AAStatus | null;
    aaMatched: number;
    tierSource: "turing" | "openrouter";
    myTier: string | null;
    nvidia: { enabled: boolean; count: number; freeTotal: number; updatedAt: number | null; error: string | null };
  };
}> {
  const [orModels, aaRows, nv] = await Promise.all([
    getOpenRouterModels(opts.force),
    getAA(opts.force),
    nvidiaEnabled() ? loadNvidiaFree(opts.force).catch(() => null) : Promise.resolve(null),
  ]);
  // Free NVIDIA models by word key, to mark Turing models that are also free on NVIDIA.
  const nvByKey = new Map<string, NvidiaModel>();
  for (const x of nv?.models ?? []) nvByKey.set(nameKey(x.id), x);
  const turing = getTuring();
  const { entries, byId } = collectEntries(orModels);
  const aaIdx = buildAAIndex(aaRows);
  const aaLoose = buildLooseIndex(aaRows);
  const aaBySlug = new Map(aaRows.map((r) => [String(r.slug ?? ""), r]));
  const overrides = loadOverrides();
  const myTier = turing.learner?.tier ?? null;
  const pings = getPingResults();
  const keyModels = getKeyModels();
  const firstSeen = kvGet<Record<string, number>>("turing:firstSeen")?.value ?? {};
  const now = Date.now();

  const since30 = now - 30 * 24 * 3600 * 1000;
  const u30 = usageBySlug(since30);
  const uAll = usageBySlug(0);
  // Ids that a catalog row owns exactly. A prefix match ("-2024-07-18", ":free") must not also count usage
  // that belongs to another row, e.g. "x:batch" when both "x" and "x:batch" are in the list.
  const owned = new Set<string>();
  for (const e of entries) {
    owned.add(e.slug);
    if (e.m) owned.add(e.m.id);
  }
  const matchUsage = (map: Map<string, { requests: number; cost: number; tokens: number }>, ...ids: string[]) => {
    const acc = { requests: 0, cost: 0, tokens: 0 };
    for (const [k, v] of map) {
      if (ids.some((slug) => k === slug || (!owned.has(k) && (k.startsWith(slug + "-20") || k.startsWith(slug + ":"))))) {
        acc.requests += v.requests;
        acc.cost += v.cost;
        acc.tokens += v.tokens;
      }
    }
    return acc;
  };

  let aaMatched = 0;
  const models: CatalogModel[] = [];
  for (const { slug, label, tiers, m, kind, listed, free } of entries) {
    const p = m?.pricing ?? {};
    const params = m?.supported_parameters ?? [];
    const inMods = m?.architecture?.input_modalities ?? [];
    const aa = findAA(aaIdx, aaLoose, aaBySlug, m?.id ?? slug, m?.name ?? label ?? slug, overrides[slug]);
    const benchmarks = mergeBenchmarks(m, aa ? toBenchmarks(aa) : null);
    if (benchmarks) aaMatched++;
    const cacheRead = perMillion(p.input_cache_read);
    const orId = m && m.id !== slug ? m.id : null;
    const outMods = m?.architecture?.output_modalities ?? [];
    const cats = categorize(m, slug);
    const chatModel = (!outMods.length || outMods.includes("text")) && !cats.some((c) => ["Image gen", "Audio", "Embedding", "Rerank"].includes(c));
    const availability = decideAvailability({ slug, orId: m?.id ?? null, listed, chatModel, free, keyModels, now });
    const ping = pings[slug];
    const plan = testPlan(slug, m, categorize(m, slug));
    const seen = firstSeen[slug] ?? null;
    const perReq = Number(p.request);
    const alt = nvByKey.get(nameKey(slug)) ?? (m ? nvByKey.get(nameKey(m.id)) : undefined);
    models.push({
      source: "turing",
      apiId: null,
      nvidiaUrl: null,
      nvidiaAlt: alt ? { id: alt.id, url: alt.url } : null,
      slug,
      orId,
      matchKind: kind,
      orStatus: listed ? "listed" : m ? "unlisted" : "none",
      label: label ?? m?.name ?? slug,
      name: m?.name ?? label ?? slug,
      provider: slug.replace(/^~/, "").split("/")[0],
      description: m?.description ?? "",
      tiers,
      inMyTier: tierIncludes(myTier, tiers),
      available: availability.state !== "unavailable",
      availability,
      providers: free?.endpoints ?? [],
      lastTest: ping ? { verdict: ping.verdict, at: ping.at, latencyMs: ping.latencyMs, cost: ping.cost, works: ping.works, text: describeTest(ping) } : null,
      test: { possible: plan.kind !== "skip", estCost: plan.estCost, note: plan.kind === "skip" ? plan.skipReason ?? null : plan.costNote ?? null },
      expirationDate: m?.expiration_date ?? null,
      isNew: !!seen && now - seen < NEW_FOR,
      firstSeen: seen,
      inOpenRouter: listed,
      categories: categorize(m, slug),
      inputModalities: inMods,
      outputModalities: m?.architecture?.output_modalities ?? [],
      contextLength: m?.context_length ?? m?.top_provider?.context_length ?? null,
      maxOutput: m?.top_provider?.max_completion_tokens ?? null,
      params: paramsFromName(m?.hugging_face_id, slug, m?.name),
      openWeights: !!m?.hugging_face_id,
      priceIn: perMillion(p.prompt),
      priceOut: perMillion(p.completion),
      priceCacheRead: cacheRead,
      priceCacheWrite: perMillion(p.input_cache_write),
      priceReasoning: perMillion(p.internal_reasoning),
      priceRequest: Number.isFinite(perReq) && perReq > 0 ? perReq : null,
      features: {
        tools: params.includes("tools"),
        structured: params.includes("structured_outputs") || params.includes("response_format"),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
        caching: cacheRead !== null,
        vision: inMods.includes("image"),
      },
      created: m?.created ?? null,
      benchmarks,
      usage30d: matchUsage(u30, slug, ...(m ? [m.id] : [])),
      usageAll: matchUsage(uAll, slug, ...(m ? [m.id] : [])),
    });
  }

  if (nv) {
    const tests = getNvidiaTests();
    for (const x of nv.models) models.push(nvidiaRow(x, nv, byId, tests[x.id], (b) => b && aaMatched++, (id) => matchUsage(u30, id), (id) => matchUsage(uAll, id), (m) => {
      const aa = findAA(aaIdx, aaLoose, aaBySlug, m?.id ?? x.id, m?.name ?? x.name, overrides[`nvidia:${x.id}`]);
      return mergeBenchmarks(m, aa ? toBenchmarks(aa) : null);
    }));
  }

  return {
    models,
    meta: {
      orUpdatedAt: kvGet("or:models")?.updatedAt ?? null,
      aaEnabled: !!process.env.AA_API_KEY,
      aaUpdatedAt: kvGet("aa:models")?.updatedAt ?? null,
      aaStatus: getAAStatus(),
      aaMatched,
      tierSource: turing.tiers.length ? "turing" : "openrouter",
      myTier,
      nvidia: {
        enabled: nvidiaEnabled(),
        count: nv?.models.length ?? 0,
        freeTotal: nv?.freeTotal ?? 0,
        updatedAt: nv?.at ?? null,
        error: nv?.error ?? null,
      },
    },
  };
}

type Usage = { requests: number; cost: number; tokens: number };

// One catalog row for a free NVIDIA model. Benchmarks come from the same model on OpenRouter (matched by words).
function nvidiaRow(
  x: NvidiaModel,
  nv: NvidiaState,
  byId: Map<string, ORModel>,
  test: PingResult | undefined,
  countBench: (b: Benchmarks | null) => unknown,
  u30: (id: string) => Usage,
  uAll: (id: string) => Usage,
  bench: (m: ORModel | undefined) => Benchmarks | null,
): CatalogModel {
  const m = resolveWithKind(x.id, byId).model as ORModel | undefined;
  const benchmarks = bench(m);
  countBench(benchmarks);
  const tagCats: string[] = [];
  const has = (re: RegExp) => x.tags.some((t) => re.test(t));
  if (x.embedding) tagCats.push("Embedding");
  if (has(/reason/i)) tagCats.push("Reasoning");
  if (has(/vision|image-to-text|multimodal/i)) tagCats.push("Vision");
  if (has(/code|coding/i)) tagCats.push("Coding");
  if (has(/safety|guard|moderation/i)) tagCats.push("Safety");
  if (has(/translat/i)) tagCats.push("Translation");
  if (!x.embedding && (has(/chat|large language|text-to-text/i) || !tagCats.length)) tagCats.push("Chat");
  const categories = [...new Set([...tagCats, ...(m ? categorize(m, x.id).filter((c) => c !== "Chat" || !x.embedding) : [])])];
  // A failed test call greys the row out for 24 hours; after that the free list decides again.
  const failed = !!test && ["no-endpoints", "blocked"].includes(test.verdict) && Date.now() - test.at < 24 * 60 * 60 * 1000;
  const when = new Date(nv.at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const params = m?.supported_parameters ?? [];
  return {
    source: "nvidia",
    apiId: x.id,
    nvidiaUrl: x.url,
    nvidiaAlt: null,
    slug: `nvidia:${x.id}`,
    orId: null,
    matchKind: null,
    orStatus: "none",
    label: x.name,
    name: x.name,
    provider: x.publisher || x.id.split("/")[0],
    description: x.description,
    tiers: [],
    inMyTier: true,
    available: !failed,
    availability: failed
      ? { state: "unavailable", label: "Test call failed", detail: describeTest(test!), source: "none", checkedAt: test!.at }
      : {
          state: "available",
          label: "Free · NVIDIA",
          detail: `"Free Endpoint" on build.nvidia.com (list checked ${when}). Free for development and testing, with a rate limit (about 40 requests per minute). Use base_url http://localhost:${process.env.PORT ?? 8787}/api/nvidia/v1 and model "${x.id}".`,
          source: "none",
          checkedAt: nv.at,
        },
    providers: [],
    lastTest: test ? { verdict: test.verdict, at: test.at, latencyMs: test.latencyMs, cost: 0, works: test.works, text: describeTest(test) } : null,
    test: { possible: true, estCost: 0, note: null },
    expirationDate: null,
    isNew: false,
    firstSeen: null,
    inOpenRouter: false,
    categories,
    inputModalities: m?.architecture?.input_modalities ?? [],
    outputModalities: m?.architecture?.output_modalities ?? [],
    contextLength: null, // NVIDIA does not publish it in the API; the OpenRouter value can differ
    maxOutput: null,
    params: paramsFromName(m?.hugging_face_id, x.id, x.name),
    openWeights: !!m?.hugging_face_id || x.publisher !== "",
    priceIn: 0,
    priceOut: 0,
    priceCacheRead: null,
    priceCacheWrite: null,
    priceReasoning: null,
    priceRequest: null,
    features: {
      tools: has(/tool/i) || params.includes("tools"),
      structured: params.includes("structured_outputs") || params.includes("response_format"),
      reasoning: has(/reason/i) || params.includes("reasoning"),
      caching: false,
      vision: categories.includes("Vision"),
    },
    created: x.created ? Math.floor(Date.parse(x.created) / 1000) : null,
    benchmarks,
    usage30d: u30(`nim:${x.id}`),
    usageAll: uAll(`nim:${x.id}`),
  };
}

export function setBenchmarkOverride(slug: string, aaSlug: string | null): void {
  const o = loadOverrides();
  if (aaSlug) o[slug] = aaSlug;
  else delete o[slug];
  kvSet("aa:overrides", o);
}

export async function listAA(): Promise<{ slug: string; name: string }[]> {
  return (await getAA()).map((r) => ({ slug: String(r.slug ?? ""), name: String(r.name ?? "") }));
}

// All OpenRouter ids with names, for the "Link OpenRouter model" field in the UI.
export async function listOpenRouterIds(): Promise<{ id: string; name: string }[]> {
  const models = await getOpenRouterModels().catch(() => kvGet<ORModel[]>("or:models")?.value ?? []);
  return models.map((m) => ({ id: m.id, name: m.name })).sort((a, b) => a.id.localeCompare(b.id));
}
