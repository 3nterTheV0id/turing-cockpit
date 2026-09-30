import { DEFAULTS, fetchTuringData, pushToCockpit } from "./sync.js";

const ALARM = "turing-sync";

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function schedule() {
  const { intervalMinutes } = await settings();
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: Math.max(15, Number(intervalMinutes) || 60), delayInMinutes: 1 });
}

async function setBadge(ok) {
  await chrome.action.setBadgeText({ text: ok ? "" : "!" });
  if (!ok) await chrome.action.setBadgeBackgroundColor({ color: "#DC2626" });
}

let running = null;
async function runSync(reason) {
  if (running) return running;
  running = (async () => {
    const s = await settings();
    const { supabaseConfig } = await chrome.storage.local.get("supabaseConfig");
    const status = { at: Date.now(), reason, ok: false, tiers: [], learnerFound: false, cockpitReached: false, error: null, warning: null };
    try {
      const data = await fetchTuringData({ email: s.email.trim(), config: supabaseConfig });
      await chrome.storage.local.set({ supabaseConfig: data.config });
      status.tiers = (Array.isArray(data.tiers) ? data.tiers : []).map((t) => ({ name: t.name, count: (t.models || []).length }));
      status.learnerFound = !!data.learner;
      status.tier = data.learner?.tier ?? null;
      status.usage = data.learner?.usage ?? null;
      status.limit = data.learner?.limit_amount ?? null;
      if (!s.email) status.warning = "Add your course email to sync your credit and tier.";
      else if (data.learnerError) status.warning = data.learnerError;
      try {
        const res = await pushToCockpit(s.cockpitUrl, { tiers: data.tiers, learner: data.learner, source: "extension", reason });
        status.added = Array.isArray(res?.added) ? res.added : [];
        status.cockpitReached = true;
        status.ok = true;
      } catch (e) {
        status.error = `The cockpit at ${s.cockpitUrl} is not reachable. Start it with "npm start". (${e.message})`;
      }
    } catch (e) {
      status.error = e.message;
    }
    await chrome.storage.local.set({ lastStatus: status });
    await setBadge(status.ok && !status.warning);
    return status;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void schedule();
  void runSync("install");
});
chrome.runtime.onStartup.addListener(() => {
  void schedule();
  void runSync("startup");
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void runSync("timer");
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "sync") {
    schedule().then(() => runSync("manual")).then(reply);
    return true;
  }
  if (msg?.type === "status") {
    chrome.storage.local.get("lastStatus").then(({ lastStatus }) => reply(lastStatus ?? null));
    return true;
  }
  return false;
});
