import { DEFAULTS } from "./sync.js";

const $ = (id) => document.getElementById(id);
const fields = ["email", "cockpitUrl", "intervalMinutes"];

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function row(label, value, cls = "") {
  const d = document.createElement("div");
  d.className = "row";
  const a = document.createElement("span");
  a.textContent = label;
  const b = document.createElement("span");
  b.textContent = value;
  if (cls) b.className = cls;
  d.append(a, b);
  return d;
}

function render(st) {
  const box = $("status");
  box.replaceChildren();
  if (!st) return;
  box.append(row("Last sync", `${ago(st.at)} (${st.reason})`, st.ok ? "ok" : "bad"));
  if (st.tiers?.length) box.append(row("Model lists", st.tiers.map((t) => `${t.name} ${t.count}`).join(", ")));
  if (st.learnerFound) {
    box.append(row("Your tier", st.tier ?? "—"));
    if (st.usage != null) box.append(row("Credit", `$${Number(st.usage).toFixed(2)} / $${Number(st.limit).toFixed(2)}`));
  }
  box.append(row("Cockpit", st.cockpitReached ? "reached" : "not reached", st.cockpitReached ? "ok" : "bad"));
  if (st.added?.length) box.append(row("New models", st.added.join(", ")));
  if (st.warning) {
    const w = document.createElement("div");
    w.className = "warn";
    w.textContent = st.warning;
    box.append(w);
  }
  if (st.error) {
    const e = document.createElement("div");
    e.className = "bad";
    e.textContent = st.error;
    box.append(e);
  }
}

async function init() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  for (const f of fields) $(f).value = String(s[f]);
  render(await chrome.runtime.sendMessage({ type: "status" }));
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const cockpitUrl = ($("cockpitUrl").value.trim() || DEFAULTS.cockpitUrl).replace(/\/$/, "");
  const intervalMinutes = Number($("intervalMinutes").value) || 60;
  await chrome.storage.sync.set({ email, cockpitUrl, intervalMinutes });
  $("save").disabled = true;
  $("save").textContent = "Syncing…";
  try {
    render(await chrome.runtime.sendMessage({ type: "sync" }));
  } finally {
    $("save").disabled = false;
    $("save").textContent = "Save and sync";
  }
});

$("open").addEventListener("click", async () => {
  const { cockpitUrl } = await chrome.storage.sync.get(DEFAULTS);
  chrome.tabs.create({ url: cockpitUrl });
});

void init();
