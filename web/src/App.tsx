import { useCallback, useEffect, useState } from "react";
import { api, usePersistent } from "./api";
import type { CatalogMeta, CatalogModel, Status } from "./types";
import { ago, usd } from "./format";
import { Pulse, Refresh, SunMoon } from "./ui";
import Catalog from "./Catalog";
import Usage from "./Usage";

export default function App() {
  const [tab, setTab] = usePersistent<"catalog" | "usage">("cockpit:tab", "catalog");
  const [theme, setTheme] = usePersistent<"dark" | "light">("cockpit:theme", "dark");
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([api.status(), api.catalog(refresh)]);
      setStatus(s);
      setModels(c.models);
      setMeta(c.meta);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const reload = useCallback(() => void load(), [load]);

  useEffect(() => {
    void load();
    // Pick up new syncs from the extension and new logged requests.
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const learner = status?.learner;
  const pct = learner?.usage !== undefined && learner?.limit ? Math.min(100, (learner.usage / learner.limit) * 100) : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand" title="Model Cockpit"><Pulse /> <span className="brand-text">Model Cockpit</span></div>
        <nav className="tabs" aria-label="Views">
          <button aria-pressed={tab === "catalog"} onClick={() => setTab("catalog")}>Catalog</button>
          <button aria-pressed={tab === "usage"} onClick={() => setTab("usage")}>Usage</button>
        </nav>
        <div className="spacer" />
        {pct !== null && (
          <div className="credit" title={`Tier: ${learner?.tier ?? "?"} · Turing data from ${ago(status?.turingSyncedAt)}`}>
            <div className="credit-row">
              <span>Turing credit{learner?.tier ? ` (${learner.tier})` : ""}</span>
              <b>{usd(learner?.usage, 2)} / {usd(learner?.limit, 2)}</b>
            </div>
            <div className={`meter${pct >= 100 ? " bad" : pct >= 80 ? " warn" : ""}`}><span style={{ width: `${pct}%` }} /></div>
          </div>
        )}
        <span className="small muted sync-note" title="Last sync from the Chrome extension">Synced {ago(status?.turingSyncedAt)}</span>
        <button className="icon-btn" aria-label="Reload OpenRouter data" title="Reload OpenRouter data" onClick={() => void load(true)}><Refresh /></button>
        <button className="icon-btn" aria-label="Switch theme" title="Switch theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><SunMoon light={theme === "dark"} /></button>
      </header>

      {error && (
        <div className="banner warn" role="alert">
          <p><b>The cockpit cannot load data.</b> {error}. Make sure that the server runs (<code>npm start</code>) and that your computer is online.</p>
        </div>
      )}
      {!error && status && !status.turingSyncedAt && (
        <div className="banner">
          <p>
            <b>No Turing College data yet.</b> The list shows all OpenRouter models. Install the <b>Turing Cockpit Sync</b> extension, open it, enter your
            course email and click <b>Save and sync</b>. The extension then sends your model list and credit every hour.
          </p>
        </div>
      )}

      {tab === "catalog" ? (
        <Catalog models={models} meta={meta} loading={loading} onReload={reload} />
      ) : (
        <Usage models={models} learner={learner ?? null} />
      )}
    </div>
  );
}
