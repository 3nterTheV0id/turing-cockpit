import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { AvailabilityStatus, CatalogModel, ProviderInfo } from "./types";
import { ago, perM, tokens, usd } from "./format";
import { CopyButton, InfoTip, copyText } from "./ui";

// How long the result of a test call stays in the status column before the provider label comes back.
export const TEST_FLASH_MS = 3000;

// Polls the free availability check and calls onChanged when it ends, so the catalog reloads.
export function useAvailability(onChanged: () => void) {
  const [status, setStatus] = useState<AvailabilityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const s = await api.availability();
      setStatus(s);
      const running = !!s.job && s.job.finishedAt === null;
      if (wasRunning.current && !running) onChanged();
      wasRunning.current = running;
      return running;
    } catch {
      return false;
    }
  }, [onChanged]);

  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const running = await refresh();
      if (live) t = setTimeout(loop, running ? 1000 : 15_000);
    };
    void loop();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [refresh]);

  const run = async () => {
    setError(null);
    try {
      await api.check();
      wasRunning.current = true;
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { status, error, run, clearError: () => setError(null) };
}

export function AvailabilityBar({ models, avail }: { models: CatalogModel[]; avail: ReturnType<typeof useAvailability> }) {
  const { status, error, run } = avail;
  const job = status?.job;
  const running = !!job && job.finishedAt === null;
  const bad = models.filter((m) => !m.available).length;
  return (
    <div className="menu avail-bar">
      <button className="btn" onClick={() => void run()} disabled={running} title="Free check: the model list of your key and the providers on OpenRouter. No test calls, no cost.">
        {running ? `Checking ${job.done}/${job.total}…` : "Check availability"}
      </button>
      <InfoTip label="About the availability check" width={320}>
        Free check, no cost. It reads the model list of your key (OpenRouter /models/user, needs <code>OPENROUTER_API_KEY</code>) and the providers of each model.
        It runs by itself at the start and every 6 hours.
        <br />
        Last check: {ago(status?.lastFreeAt)}.{" "}
        {status?.keyModelsCount ? `Your key may use ${status.keyModelsCount} models.` : status?.keyConfigured ? "Key list not read yet." : "No key in .env: only the provider check runs."}{" "}
        {bad ? `${bad} Turing models do not work now (greyed out).` : ""}
      </InfoTip>
      {(error || job?.error) && !running && (
        <div className="small bad-text" role="alert" style={{ position: "absolute", right: 0, top: 42, width: 280, zIndex: 31 }} onClick={avail.clearError}>
          {error ?? job?.error}
        </div>
      )}
    </div>
  );
}

const DOT: Record<string, string> = { available: "ok", unavailable: "bad", degraded: "warn", unknown: "none" };

export function StatusCell({ m, canTest, onTested }: { m: CatalogModel; canTest: boolean; onTested: () => void }) {
  const a = m.availability;
  const [testing, setTesting] = useState(false);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const labelRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const test = async () => {
    const cost = m.test.estCost;
    const needsOk = m.source !== "nvidia" && (cost > 0.001 || !!m.test.note);
    if (needsOk && !window.confirm(`Test call to ${m.slug}.\nExpected cost: about ${usd(Math.max(cost, 0.00001), 4)}.${m.test.note ? `\n${m.test.note}` : ""}\n\nSend the test call?`)) return;
    setTesting(true);
    clearTimeout(timer.current);
    try {
      const { result } = m.source === "nvidia" && m.apiId ? await api.nvidiaTest(m.apiId) : await api.test(m.slug);
      const lat = result.latencyMs ? ` · ${(result.latencyMs / 1000).toFixed(1)} s` : "";
      const text =
        result.verdict === "ok"
          ? result.works && result.works !== (m.apiId ?? m.slug)
            ? `Works as ${result.works}`
            : `Works${lat}`
          : `Failed${result.status ? ` (${result.status})` : ""}`;
      setFlash({ text, ok: result.verdict === "ok" });
    } catch (e) {
      setFlash({ text: (e as Error).message.slice(0, 40), ok: false });
    } finally {
      setTesting(false);
      timer.current = setTimeout(() => setFlash(null), TEST_FLASH_MS);
      onTested();
    }
  };

  const hasProviders = m.providers.length > 0;
  return (
    <span className="status-cell">
      <span className={`dot ${flash ? (flash.ok ? "ok" : "bad") : DOT[a.state]}`} aria-hidden="true" />
      {testing ? (
        <span className="muted">Testing…</span>
      ) : flash ? (
        <span className={`flash ${flash.ok ? "ok-text" : "bad-text"}`} role="status">{flash.text}</span>
      ) : hasProviders ? (
        <button
          ref={labelRef}
          className={`link-btn status-label${a.state === "unavailable" ? " bad-text" : a.state === "degraded" ? " warn-text" : ""}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Show the providers"
          onClick={() => setOpen(!open)}
        >
          {a.label}
        </button>
      ) : (
        <span className={a.state === "unavailable" ? "bad-text" : a.state === "degraded" ? "warn-text" : ""}>{a.label}</span>
      )}
      <InfoTip label={`Availability of ${m.label}`} width={330}>
        {a.detail}
        {m.lastTest && (
          <>
            <br />
            {m.lastTest.text}
          </>
        )}
        {!m.test.possible && m.test.note && (
          <>
            <br />
            No test call: {m.test.note}
          </>
        )}
      </InfoTip>
      {canTest && m.test.possible && (
        <button
          className="copy"
          title={m.source === "nvidia" ? "Test call for this model (free; counts against the NVIDIA rate limit)" : `Test call for this model (about ${usd(Math.max(m.test.estCost, 0.00001), 4)})`}
          aria-label={`Test call for ${m.label}`}
          disabled={testing}
          onClick={() => void test()}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M5 12h3l3-7 4 14 3-7h1" />
          </svg>
        </button>
      )}
      {open && hasProviders && <ProviderPopover m={m} anchor={labelRef.current} onClose={() => setOpen(false)} />}
    </span>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${v >= 99.95 ? "100" : v.toFixed(1)}%`);

// Click on the provider label: all providers of the model with their metrics and a copy button for the provider slug.
export function ProviderPopover({ m, anchor, onClose }: { m: CatalogModel; anchor: HTMLElement | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const width = Math.min(860, window.innerWidth - 16);

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.left - 40));
      const below = window.innerHeight - r.bottom - 16;
      const above = r.top - 16;
      const useBelow = below >= 260 || below >= above;
      setPos(useBelow ? { top: r.bottom + 6, left, maxHeight: below } : { top: Math.max(8, r.top - 6 - Math.min(above, 520)), left, maxHeight: Math.min(above, 520) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    ref.current?.focus();
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);

  const rows = [...m.providers].sort((a, b) => (b.status === 0 ? 1 : 0) - (a.status === 0 ? 1 : 0) || (b.uptime30m ?? -1) - (a.uptime30m ?? -1));
  const id = m.orId ?? m.slug;
  return createPortal(
    <div
      ref={ref}
      className="provider-pop"
      role="dialog"
      aria-label={`Providers of ${m.label}`}
      tabIndex={-1}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? 0, width, maxHeight: pos?.maxHeight }}
    >
      <header>
        <div>
          <b>{m.label}</b> <span className="muted small">· {rows.length} provider{rows.length === 1 ? "" : "s"} on OpenRouter · checked {ago(m.availability.checkedAt)}</span>
        </div>
        <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="table-scroll">
        <table className="cmp provider-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Provider slug</th>
              <th>Status</th>
              <th className="num" title="Share of successful requests">Uptime 30 min</th>
              <th className="num">Uptime 1 day</th>
              <th className="num" title="Median time to first token, last 30 min">Latency</th>
              <th className="num" title="Median tokens per second, last 30 min">Tok/s</th>
              <th className="num">In $/M</th>
              <th className="num">Out $/M</th>
              <th className="num">Cache read $/M</th>
              <th className="num">Context</th>
              <th className="num">Max out</th>
              <th>Quant.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p: ProviderInfo) => (
              <tr key={p.slug + p.provider}>
                <td>{p.provider}</td>
                <td>
                  <span className="slug">
                    <code>{p.slug}</code>
                    <CopyButton text={p.slug} label={`Copy provider slug ${p.slug}`} />
                  </span>
                </td>
                <td>{p.status === 0 || p.status === null ? <span className="ok-text">OK</span> : <span className="warn-text" title={`OpenRouter status ${p.status}: ranked down`}>ranked down</span>}</td>
                <td className="num">{pct(p.uptime30m)}</td>
                <td className="num">{pct(p.uptime1d)}</td>
                <td className="num">{p.latency30m === null ? "—" : `${p.latency30m.toFixed(2)} s`}</td>
                <td className="num">{p.throughput30m === null ? "—" : Math.round(p.throughput30m)}</td>
                <td className="num">{perM(p.priceIn)}</td>
                <td className="num">{perM(p.priceOut)}</td>
                <td className="num">{perM(p.priceCacheRead)}</td>
                <td className="num">{tokens(p.contextLength)}</td>
                <td className="num">{tokens(p.maxOutput)}</td>
                <td>{p.quantization ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="small muted">
        Use the slug in <code>provider.order</code> or <code>provider.only</code> to send calls to one provider. The part before "/" (for example <code>{rows[0]?.slug.split("/")[0]}</code>) matches all endpoints of that provider.{" "}
        <button
          className="link-btn small"
          onClick={() =>
            void copyText(JSON.stringify({ model: id, provider: { order: rows.filter((p) => p.status === 0).map((p) => p.slug).slice(0, 3), allow_fallbacks: true } }, null, 2))
          }
        >
          Copy example request body
        </button>
        . Source: OpenRouter endpoints API. Latency and speed are empty when OpenRouter does not send them.
      </footer>
    </div>,
    document.body,
  );
}

// Field to link a Turing slug to an OpenRouter id by hand.
let idCache: Promise<{ id: string; name: string }[]> | null = null;
export function LinkEditor({ m, onDone }: { m: CatalogModel; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<{ id: string; name: string }[]>([]);
  const [value, setValue] = useState(m.matchKind === "manual" ? m.orId ?? "" : "");
  const [err, setErr] = useState<string | null>(null);
  const listId = `or-ids-${m.slug.replace(/[^a-z0-9]/gi, "-")}`;
  useEffect(() => {
    if (!open) return;
    idCache ??= api.orIds();
    idCache.then(setIds).catch(() => setIds([]));
  }, [open]);
  const save = async (orId: string | null) => {
    if (orId && ids.length && !ids.some((x) => x.id === orId)) {
      setErr("This id is not in the OpenRouter list.");
      return;
    }
    await api.link(m.slug, orId);
    setOpen(false);
    onDone();
  };
  if (!open) {
    return (
      <button className="link-btn small" onClick={() => setOpen(true)}>
        {m.matchKind === "manual" ? "Change link" : m.orStatus === "listed" ? "Wrong match? Link another model" : "Link an OpenRouter model"}
      </button>
    );
  }
  return (
    <span className="link-editor">
      <input
        className="input"
        list={listId}
        placeholder="provider/model"
        aria-label={`OpenRouter id for ${m.slug}`}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setErr(null);
        }}
        autoFocus
      />
      <datalist id={listId}>
        {ids.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </datalist>
      <button className="btn primary" style={{ height: 30 }} onClick={() => void save(value.trim() || null)}>
        Save
      </button>
      {m.matchKind === "manual" && (
        <button className="btn ghost" style={{ height: 30 }} onClick={() => void save(null)}>
          Remove link
        </button>
      )}
      <button className="btn ghost" style={{ height: 30 }} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {err && <span className="small bad-text">{err}</span>}
    </span>
  );
}
