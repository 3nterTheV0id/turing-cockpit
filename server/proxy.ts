// OpenRouter-compatible pass-through proxy.
// Point your code to http://localhost:8787/api/v1 instead of https://openrouter.ai/api/v1.
// The proxy forwards every request without changes (plus usage accounting) and logs model, tokens and cost.
import type { Context } from "hono";
import { saveRequest, setRequestCost } from "./db.ts";

export const upstreamBase = () => process.env.OPENROUTER_UPSTREAM ?? "https://openrouter.ai/api/v1";
const LOGGED = /\/(chat\/completions|completions|responses|embeddings)$/;
// Headers that must not go to OpenRouter. fetch() rejects "expect" (curl sends it for bodies > 1 MB) and the other
// hop-by-hop headers. Cookies, Origin and Referer of the local page are not for OpenRouter.
const HOP = new Set([
  "host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive",
  "expect", "upgrade", "te", "trailer", "proxy-connection", "proxy-authorization",
  "cookie", "origin", "referer",
]);

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface Captured { id?: string; model?: string; provider?: string; usage?: Usage }

export function extractFromJson(j: unknown, into: Captured = {}): Captured {
  if (!j || typeof j !== "object") return into;
  const o = j as Record<string, unknown>;
  const resp = (o.response as Record<string, unknown> | undefined) ?? o; // Responses API events wrap the response
  if (typeof resp.id === "string" && !into.id) into.id = resp.id;
  if (typeof resp.model === "string") into.model = resp.model;
  if (typeof resp.provider === "string") into.provider = resp.provider;
  if (resp.usage && typeof resp.usage === "object") into.usage = resp.usage as Usage;
  return into;
}

// Parse the SSE text of a streamed answer. The last data chunk carries the usage object.
export function extractFromSSE(text: string, into: Captured = {}): Captured {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      extractFromJson(JSON.parse(payload), into);
    } catch {
      /* partial or non-JSON line */
    }
  }
  return into;
}

// Where the proxy sends a request. OpenRouter is the default; NVIDIA (free endpoints) is the second target.
export interface ProxyTarget {
  name: string; // for error messages
  prefix: RegExp; // local path prefix to remove, e.g. /^\/api\/v1/
  base: () => string; // upstream base URL
  auth: (incoming: string | null) => string | null; // Authorization header to send
  addUsageAccounting: boolean; // OpenRouter only: usage: { include: true }
  modelPrefix: string; // stored in the log before the model id ("nim:" for NVIDIA)
  provider?: string; // stored as provider when the answer names none
  freeCost?: boolean; // log cost 0 (no cost lookup)
}

export const OPENROUTER: ProxyTarget = {
  name: "OpenRouter",
  prefix: /^\/api\/v1/,
  base: upstreamBase,
  auth: (incoming) => incoming ?? (process.env.OPENROUTER_API_KEY ? `Bearer ${process.env.OPENROUTER_API_KEY}` : null),
  addUsageAccounting: true,
  modelPrefix: "",
};

function record(c: Captured, fallbackModel: string, endpoint: string, started: number, status: number, streamed: boolean, auth: string | null, t: ProxyTarget = OPENROUTER) {
  const u = c.usage ?? {};
  const rawId = c.id ?? `local-${started}-${Math.random().toString(36).slice(2, 8)}`;
  // Free targets need no cost lookup by id, so a local suffix keeps every call as its own row.
  const id = t.modelPrefix ? `${t.modelPrefix}${rawId}-${started}-${Math.random().toString(36).slice(2, 6)}` : rawId;
  const cost = t.freeCost ? 0 : typeof u.cost === "number" ? u.cost : null;
  saveRequest({
    id,
    ts: started,
    model: `${t.modelPrefix}${c.model ?? fallbackModel}`,
    provider: c.provider ?? t.provider,
    endpoint,
    prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
    cost,
    latency_ms: Date.now() - started,
    status,
    streamed,
  });
  // No cost in the answer: ask the generation endpoint a few seconds later (costs settle after the call).
  if (cost === null && c.id && auth && !t.freeCost) void fillCostLater(c.id, auth);
}

async function fillCostLater(id: string, auth: string, attempt = 1): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000 * attempt));
  try {
    const res = await fetch(`${upstreamBase()}/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: auth } });
    if (res.ok) {
      const j = (await res.json()) as { data?: { total_cost?: number; provider_name?: string } };
      if (typeof j.data?.total_cost === "number") return setRequestCost(id, j.data.total_cost, j.data.provider_name);
    }
  } catch {
    /* retry below */
  }
  if (attempt < 3) return fillCostLater(id, auth, attempt + 1);
}

export async function proxy(c: Context, t: ProxyTarget = OPENROUTER): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(t.prefix, "");
  const target = t.base() + path + url.search;

  const headers = new Headers();
  c.req.raw.headers.forEach((v, k) => {
    if (!HOP.has(k.toLowerCase())) headers.set(k, v);
  });
  const auth = t.auth(headers.get("authorization"));
  if (auth) headers.set("authorization", auth);
  else headers.delete("authorization");

  const method = c.req.method;
  const logged = method === "POST" && LOGGED.test(path);
  let body: BodyInit | undefined;
  let requestedModel = "unknown";
  let wantsStream = false;

  if (method !== "GET" && method !== "HEAD") {
    const raw = await c.req.raw.arrayBuffer();
    body = raw;
    if (logged && (headers.get("content-type") ?? "").includes("json")) {
      try {
        const j = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        requestedModel = typeof j.model === "string" ? j.model : Array.isArray(j.models) ? String(j.models[0]) : "unknown";
        wantsStream = j.stream === true;
        // Ask OpenRouter to put the cost into the usage object.
        if (t.addUsageAccounting && /chat\/completions|\/completions$/.test(path) && !j.usage) {
          j.usage = { include: true };
          body = JSON.stringify(j);
        }
      } catch {
        /* forward the body unchanged */
      }
    }
  }

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, { method, headers, body, redirect: "manual" });
  } catch (e) {
    const err = e as Error & { cause?: { message?: string } };
    const why = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
    return c.json({ error: { message: `Cockpit proxy: ${t.name} is not reachable (${why})` } }, 502);
  }

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");

  if (!logged || !upstream.body) {
    return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
  }

  const isSSE = (upstream.headers.get("content-type") ?? "").includes("event-stream") || wantsStream;
  if (!isSSE) {
    const text = await upstream.text();
    try {
      if (upstream.ok) record(extractFromJson(JSON.parse(text)), requestedModel, path, started, upstream.status, false, auth, t);
    } catch {
      /* not JSON */
    }
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  // Streamed answer: pass each chunk through at once and parse a copy.
  const decoder = new TextDecoder();
  let buffer = "";
  const captured: Captured = {};
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const cut = buffer.lastIndexOf("\n");
      if (cut >= 0) {
        extractFromSSE(buffer.slice(0, cut), captured);
        buffer = buffer.slice(cut + 1);
      }
    },
    flush() {
      extractFromSSE(buffer, captured);
      if (upstream.ok) record(captured, requestedModel, path, started, upstream.status, true, auth, t);
    },
  });
  return new Response(upstream.body.pipeThrough(tap), { status: upstream.status, headers: outHeaders });
}
