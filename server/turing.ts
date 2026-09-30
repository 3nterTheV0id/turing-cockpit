// Data that the Chrome extension syncs from the Turing College usage tracker.
import { kvGet, kvSet } from "./db.ts";

export interface TierModel { id: string; label?: string }
export interface Tier { name: string; models: TierModel[]; updated_at?: string }
export interface DailyPoint { date: string; amount: number }
export interface Learner {
  keyName?: string;
  batch?: string;
  firstName?: string;
  usage?: number;
  limit?: number;
  lastUpdated?: string;
  tier?: string;
  notificationThreshold?: number;
  dailyUsage?: DailyPoint[];
}
export interface TuringState { tiers: Tier[]; learner: Learner | null; syncedAt: number | null }

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// The shape of daily_usage is not documented. Accept an array of points or an object map { date: amount }.
export function normalizeDaily(raw: unknown): DailyPoint[] {
  if (Array.isArray(raw)) {
    return raw
      .map((p) => {
        const o = p as Record<string, unknown>;
        const date = String(o.date ?? o.day ?? o.d ?? "");
        const amount = num(o.amount ?? o.usage ?? o.cost ?? o.value) ?? 0;
        return { date, amount };
      })
      .filter((p) => p.date);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([date, v]) => ({ date, amount: num(v) ?? 0 }));
  }
  return [];
}

// Accept the raw row from the lookup-learner function (snake_case) or an already mapped object.
export function normalizeLearner(raw: unknown): Learner | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    keyName: (o.key_name ?? o.keyName) as string | undefined,
    batch: o.batch as string | undefined,
    firstName: (o.first_name ?? o.firstName) as string | undefined,
    usage: num(o.usage),
    limit: num(o.limit_amount ?? o.limit),
    lastUpdated: (o.last_updated ?? o.lastUpdated) as string | undefined,
    tier: ((o.tier as string | undefined) ?? "basic").toLowerCase(),
    notificationThreshold: num(o.notification_threshold ?? o.notificationThreshold),
    dailyUsage: normalizeDaily(o.daily_usage ?? o.dailyUsage),
  };
}

export function normalizeTiers(raw: unknown): Tier[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const o = t as Record<string, unknown>;
      const models = Array.isArray(o.models)
        ? (o.models as unknown[])
            .map((m) => (typeof m === "string" ? { id: m } : (m as TierModel)))
            .filter((m) => m && typeof m.id === "string")
        : [];
      return { name: String(o.name ?? "").toLowerCase(), models, updated_at: o.updated_at as string | undefined };
    })
    .filter((t) => t.name);
}

// Remembers when each Turing slug appeared first. Returns the slugs that are new since the last sync.
// The first sync ever marks all slugs with 0 ("known from the start"), so they do not show as new.
export function trackFirstSeen(tiers: Tier[], now = Date.now()): string[] {
  const seen = kvGet<Record<string, number>>("turing:firstSeen")?.value;
  const first = !seen;
  const map = seen ?? {};
  const added: string[] = [];
  for (const t of tiers) {
    for (const m of t.models) {
      if (m.id in map) continue;
      map[m.id] = first ? 0 : now;
      if (!first) added.push(m.id);
    }
  }
  kvSet("turing:firstSeen", map);
  return added;
}

export function saveTuringSync(body: { tiers?: unknown; learner?: unknown }): TuringState & { added: string[] } {
  const tiers = normalizeTiers(body.tiers);
  const added = tiers.length ? trackFirstSeen(tiers) : [];
  if (tiers.length) kvSet("turing:tiers", tiers);
  const learner = normalizeLearner(body.learner);
  if (learner) kvSet("turing:learner", learner);
  kvSet("turing:lastSync", Date.now());
  return { ...getTuring(), added };
}

export function getTuring(): TuringState {
  return {
    tiers: kvGet<Tier[]>("turing:tiers")?.value ?? [],
    learner: kvGet<Learner>("turing:learner")?.value ?? null,
    syncedAt: kvGet<number>("turing:lastSync")?.value ?? null,
  };
}
