// Matches Turing College slugs to OpenRouter model ids.
//
// Turing slugs do not always equal OpenRouter ids. Known differences (checked Sept 2026 with the real lists):
//  - router aliases need a "~" prefix            anthropic/claude-sonnet-latest -> ~anthropic/claude-sonnet-latest
//  - another provider prefix                      xai/grok-4.5 -> x-ai/grok-4.5, rerank/rerank-4-pro -> cohere/rerank-4-pro
//  - "-batch" instead of ":batch"                 google/gemini-3.7-flash-batch -> google/gemini-3.7-flash:batch
//  - short date suffix                            deepseek/deepseek-v4-flash-0423 -> deepseek/deepseek-v4-flash
//  - dated canonical slug                         google/gemma-4-31b-it-20260402 -> google/gemma-4-31b-it
//
// The steps, in order (the first hit wins):
//  1. manual link (set in the UI)
//  2. exact id, or a known spelling variant of it ("alias")
//  3. the same words in another order or with other separators ("name"), e.g. claude-4.5-haiku = claude-haiku-4.5
//     Only a single, unambiguous hit counts.
//  4. the OpenRouter endpoints API ("endpoints"). It also knows models that left the model list (see availability.ts).

export interface ORModelLite {
  id: string;
  canonical_slug?: string;
  name: string;
}

export type MatchKind = "manual" | "exact" | "alias" | "name" | "endpoints";

// Provider names that Turing (or people) write differently from OpenRouter.
export const PROVIDER_ALIASES: Record<string, string> = {
  xai: "x-ai",
  "x.ai": "x-ai",
  meta: "meta-llama",
  facebook: "meta-llama",
  llama: "meta-llama",
  mistral: "mistralai",
  rerank: "cohere",
  moonshot: "moonshotai",
  kimi: "moonshotai",
  zai: "z-ai",
  "z.ai": "z-ai",
  zhipu: "z-ai",
  alibaba: "qwen",
  gemini: "google",
  claude: "anthropic",
  gpt: "openai",
  "deepseek-ai": "deepseek", // NVIDIA spelling
  "nv-mistralai": "mistralai",
};

const VARIANT_SUFFIXES = ["batch", "free", "thinking", "extended", "nitro", "floor", "online", "exacto"];

// Spelling variants of a slug, most exact first.
export function slugVariants(slug: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(slug);
  const plain = slug.replace(/^~/, "");
  const cut = plain.indexOf("/");
  const prov = cut > 0 ? plain.slice(0, cut) : "";
  const name = cut > 0 ? plain.slice(cut + 1) : plain;
  const provs = [prov, PROVIDER_ALIASES[prov.toLowerCase()]].filter((p): p is string => !!p);
  if (!provs.length) provs.push("");
  for (const p of provs) {
    const base = p ? `${p}/${name}` : name;
    add(base);
    add(`~${base}`);
    for (const v of VARIANT_SUFFIXES) if (base.endsWith(`-${v}`)) add(`${base.slice(0, -v.length - 1)}:${v}`);
    const undated = base
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-\d{4}$/, "");
    add(undated);
    add(`~${undated}`);
  }
  // Last resort: the base model of a "-batch" or "-free" slug.
  for (const v of [...out]) {
    const m = v.match(/^(.*)-(batch|free)$/);
    if (m) add(m[1]);
  }
  return out;
}

// Word key of a model id or name: provider, variant and date removed, words sorted.
// "claude-3-5-haiku", "claude-3.5-haiku" and "Claude Haiku 3.5" give the same key.
export function nameKey(idOrName: string): string {
  let s = idOrName.toLowerCase().replace(/^~/, "").replace(/:.*$/, "");
  s = s.replace(/^[^/\s]+\//, ""); // provider
  s = s.replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const raw = s.split(/[^a-z0-9.]+/).filter(Boolean);
  // Merge version numbers that were written with "-" ("3-5" -> "3.5").
  const toks: string[] = [];
  for (const t of raw) {
    const prev = toks[toks.length - 1];
    if (/^\d{1,2}$/.test(t) && prev !== undefined && /^\d{1,2}(\.\d{1,2})*$/.test(prev)) toks[toks.length - 1] = `${prev}.${t}`;
    else toks.push(t.replace(/^\.+|\.+$/g, ""));
  }
  return [...new Set(toks.filter((t) => t && !/^\d{4}$/.test(t) && !/^\d{6,8}$/.test(t)))].sort().join("|");
}

const providerOf = (id: string) => {
  const p = id.replace(/^~/, "").split("/")[0].toLowerCase();
  return PROVIDER_ALIASES[p] ?? p;
};

interface NameIndex {
  byProvider: Map<string, Set<ORModelLite>>;
  any: Map<string, Set<ORModelLite>>;
}
const nameIndexCache = new WeakMap<Map<string, ORModelLite>, NameIndex>();

function nameIndex(byId: Map<string, ORModelLite>): NameIndex {
  const hit = nameIndexCache.get(byId);
  if (hit) return hit;
  const idx: NameIndex = { byProvider: new Map(), any: new Map() };
  const put = (map: Map<string, Set<ORModelLite>>, k: string, m: ORModelLite) => {
    if (!k) return;
    const set = map.get(k) ?? new Set();
    set.add(m);
    map.set(k, set);
  };
  for (const [key, m] of byId) {
    // Variants (":free") and routers ("~") only match through the exact steps.
    if (m.id.includes(":") || m.id.startsWith("~")) continue;
    for (const src of [key, m.id]) {
      const k = nameKey(src);
      put(idx.byProvider, `${providerOf(src)}#${k}`, m);
      put(idx.any, k, m);
    }
  }
  nameIndexCache.set(byId, idx);
  return idx;
}

export function resolveWithKind(
  slug: string,
  byId: Map<string, ORModelLite>,
  links: Record<string, string> = {},
): { model: ORModelLite | undefined; kind: MatchKind | null } {
  const manual = links[slug];
  if (manual && byId.get(manual)) return { model: byId.get(manual), kind: "manual" };

  const variants = slugVariants(slug);
  for (const v of variants) {
    const m = byId.get(v);
    if (m) return { model: m, kind: v === slug ? "exact" : "alias" };
  }

  // Same words. A ":batch"/":free" slug must land on the same variant, so the name step skips those.
  if (!/[:~]/.test(slug)) {
    const idx = nameIndex(byId);
    // A variant word at the end ("-batch", "-free") selects the ":batch"/":free" variant of the model found.
    const suffix = VARIANT_SUFFIXES.find((v) => slug.toLowerCase().endsWith(`-${v}`));
    const base = suffix ? slug.slice(0, -suffix.length - 1) : slug;
    const k = nameKey(base);
    const one = (set: Set<ORModelLite> | undefined) => (set && set.size === 1 ? [...set][0] : undefined);
    const hit = one(idx.byProvider.get(`${providerOf(base)}#${k}`)) ?? one(idx.any.get(k));
    if (hit) return { model: (suffix && byId.get(`${hit.id}:${suffix}`)) || hit, kind: "name" };
  }
  return { model: undefined, kind: null };
}

export function resolveOpenRouter<T extends ORModelLite>(slug: string, byId: Map<string, T>, links: Record<string, string> = {}): T | undefined {
  return resolveWithKind(slug, byId as Map<string, ORModelLite>, links).model as T | undefined;
}

// Exact ids first. A canonical slug is only a fallback, and it points to the normal variant:
// ":batch" and ":free" variants share the canonical slug with the normal model and must not replace it.
export function buildIdIndex<T extends ORModelLite>(models: T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const m of models) byId.set(m.id, m);
  for (const m of models) {
    const c = m.canonical_slug;
    if (!c || c === m.id) continue;
    const cur = byId.get(c);
    if (!cur || (cur.id.includes(":") && !m.id.includes(":"))) {
      if (!cur || cur.id !== c) byId.set(c, m);
    }
  }
  return byId;
}
