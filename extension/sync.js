// Sync logic. Shared by the service worker (background.js) and the tests.
export const SITE = "https://api-usage-tracker.turingcollege.com/";
export const DEFAULTS = { email: "", cockpitUrl: "http://localhost:8787", intervalMinutes: 60 };
const CONFIG_TTL = 24 * 60 * 60 * 1000;

function decodeJwtPayload(jwt) {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
  } catch {
    return null;
  }
}

// Read the Supabase URL and the public (anon) key from the site's own JavaScript bundle.
// The key is public: every visitor of the site receives it. Reading it again each day keeps the sync working after a key change.
export function extractSupabaseConfig(js) {
  const url = (js.match(/https:\/\/[a-z0-9]{10,}\.supabase\.co/) || [])[0];
  const publishable = (js.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0];
  const jwts = [...new Set(js.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [])];
  const anon = jwts.find((k) => decodeJwtPayload(k)?.role === "anon");
  const key = anon || publishable;
  return url && key ? { supabaseUrl: url, anonKey: key } : null;
}

export async function discoverConfig(fetchImpl = fetch) {
  const html = await (await fetchImpl(SITE, { cache: "no-store" })).text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => new URL(m[1], SITE).href);
  srcs.sort((a, b) => Number(b.includes("/assets/index")) - Number(a.includes("/assets/index")));
  for (const src of srcs) {
    const js = await (await fetchImpl(src, { cache: "no-store" })).text();
    const cfg = extractSupabaseConfig(js);
    if (cfg) return { ...cfg, at: Date.now() };
  }
  throw new Error("Could not find the Supabase settings on the Turing site. The site may have changed.");
}

async function sbFetch(cfg, path, init = {}, fetchImpl = fetch) {
  return fetchImpl(cfg.supabaseUrl + path, {
    ...init,
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

export async function fetchTuringData({ email, config, fetchImpl = fetch }) {
  let cfg = config && Date.now() - config.at < CONFIG_TTL ? config : await discoverConfig(fetchImpl);
  let res = await sbFetch(cfg, "/rest/v1/model_tiers?select=*", {}, fetchImpl);
  if (res.status === 401 || res.status === 403) {
    cfg = await discoverConfig(fetchImpl); // The key changed: read it again.
    res = await sbFetch(cfg, "/rest/v1/model_tiers?select=*", {}, fetchImpl);
  }
  if (!res.ok) throw new Error(`Model list request failed (${res.status}).`);
  const tiers = await res.json();

  let learner = null;
  let learnerError = null;
  if (email) {
    const r = await sbFetch(cfg, "/functions/v1/lookup-learner", { method: "POST", body: JSON.stringify({ email }) }, fetchImpl);
    if (r.ok) {
      const j = await r.json();
      learner = j?.data ?? null;
      if (!learner) learnerError = "Turing College does not know this email.";
    } else {
      learnerError = `Usage lookup failed (${r.status}).`;
    }
  }
  return { config: cfg, tiers, learner, learnerError };
}

export async function pushToCockpit(cockpitUrl, payload, fetchImpl = fetch) {
  const r = await fetchImpl(`${cockpitUrl.replace(/\/$/, "")}/api/turing/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Cockpit answered ${r.status}.`);
  return r.json();
}
