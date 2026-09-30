// Local SQLite storage. Uses the built-in node:sqlite module (Node >= 22.13), so no native build is necessary.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.COCKPIT_DB ?? resolve(root, "data", "cockpit.db");
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    provider TEXT,
    endpoint TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cost REAL,
    latency_ms INTEGER,
    status INTEGER,
    streamed INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
  CREATE INDEX IF NOT EXISTS requests_model ON requests (model);
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export function kvGet<T>(key: string): { value: T; updatedAt: number } | null {
  const row = db.prepare("SELECT value, updated_at FROM kv WHERE key = ?").get(key) as
    | { value: string; updated_at: number }
    | undefined;
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
}

export function kvSet(key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), Date.now());
}

export interface RequestRecord {
  id: string;
  ts: number;
  model: string;
  provider?: string | null;
  endpoint?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  cost?: number | null;
  latency_ms?: number | null;
  status?: number | null;
  streamed?: boolean;
}

export function saveRequest(r: RequestRecord): void {
  db.prepare(
    `INSERT INTO requests (id, ts, model, provider, endpoint, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cost, latency_ms, status, streamed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cost = COALESCE(excluded.cost, requests.cost),
       provider = COALESCE(excluded.provider, requests.provider),
       prompt_tokens = MAX(excluded.prompt_tokens, requests.prompt_tokens),
       completion_tokens = MAX(excluded.completion_tokens, requests.completion_tokens),
       cached_tokens = MAX(excluded.cached_tokens, requests.cached_tokens),
       reasoning_tokens = MAX(excluded.reasoning_tokens, requests.reasoning_tokens)`,
  ).run(
    r.id,
    r.ts,
    r.model,
    r.provider ?? null,
    r.endpoint ?? null,
    r.prompt_tokens ?? 0,
    r.completion_tokens ?? 0,
    r.cached_tokens ?? 0,
    r.reasoning_tokens ?? 0,
    r.cost ?? null,
    r.latency_ms ?? null,
    r.status ?? null,
    r.streamed ? 1 : 0,
  );
}

export function setRequestCost(id: string, cost: number, provider?: string | null): void {
  db.prepare("UPDATE requests SET cost = ?, provider = COALESCE(?, provider) WHERE id = ?").run(cost, provider ?? null, id);
}
