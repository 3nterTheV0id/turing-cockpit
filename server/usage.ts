// Usage statistics from the local proxy log.
import { db } from "./db.ts";

export function getUsage(days: number | null) {
  const since = days ? Date.now() - days * 24 * 3600 * 1000 : 0;
  const q = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion,
              COALESCE(SUM(cached_tokens),0) AS cached, COALESCE(SUM(reasoning_tokens),0) AS reasoning,
              MIN(ts) AS first, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS pendingCost
       FROM requests WHERE ts >= ?`,
    )
    .get(since) as Record<string, number | null>;

  const byModel = q<{ model: string; requests: number; cost: number; prompt: number; completion: number; cached: number }>(
    `SELECT model, COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(prompt_tokens),0) AS prompt,
            COALESCE(SUM(completion_tokens),0) AS completion, COALESCE(SUM(cached_tokens),0) AS cached
     FROM requests WHERE ts >= ? GROUP BY model ORDER BY cost DESC, requests DESC`,
    since,
  );

  const daily = q<{ day: string; model: string; cost: number; requests: number }>(
    `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, model,
            COALESCE(SUM(cost),0) AS cost, COUNT(*) AS requests
     FROM requests WHERE ts >= ? GROUP BY day, model ORDER BY day`,
    since,
  );

  const recent = q<Record<string, unknown>>(
    `SELECT id, ts, model, provider, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost, latency_ms, streamed
     FROM requests WHERE ts >= ? ORDER BY ts DESC LIMIT 50`,
    since,
  );

  const firstEver = (db.prepare("SELECT MIN(ts) AS t FROM requests").get() as { t: number | null }).t;
  // Calls through the free NVIDIA endpoints (logged with the model prefix "nim:").
  const nvidia = db.prepare("SELECT COUNT(*) AS requests FROM requests WHERE ts >= ? AND model LIKE 'nim:%'").get(since) as { requests: number };
  return { totals, byModel, daily, recent, firstLogged: firstEver, nvidiaRequests: nvidia.requests };
}
