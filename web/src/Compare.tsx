import { useEffect, useState } from "react";
import type { CatalogModel } from "./types";
import { perM, score, tokens, usd } from "./format";
import { CopyButton } from "./ui";

type Row = { label: string; get: (m: CatalogModel) => number | string | null | undefined; fmt?: (v: number) => string; best?: "min" | "max" };

const ROWS: Row[] = [
  { label: "Status", get: (m) => m.availability.label },
  { label: "Input $/M", get: (m) => m.priceIn, fmt: (v) => perM(v), best: "min" },
  { label: "Output $/M", get: (m) => m.priceOut, fmt: (v) => perM(v), best: "min" },
  { label: "Cache read $/M", get: (m) => m.priceCacheRead, fmt: (v) => perM(v), best: "min" },
  { label: "Cache write $/M", get: (m) => m.priceCacheWrite, fmt: (v) => perM(v), best: "min" },
  { label: "Context", get: (m) => m.contextLength, fmt: tokens, best: "max" },
  { label: "Max output", get: (m) => m.maxOutput, fmt: tokens, best: "max" },
  { label: "Parameters", get: (m) => m.params ?? (m.openWeights ? "?" : "closed") },
  { label: "Intelligence index", get: (m) => m.benchmarks?.intelligence, fmt: (v) => v.toFixed(1), best: "max" },
  { label: "Coding index", get: (m) => m.benchmarks?.coding, fmt: score, best: "max" },
  { label: "Agentic index", get: (m) => m.benchmarks?.agentic, fmt: score, best: "max" },
  { label: "Math index", get: (m) => m.benchmarks?.math, fmt: score, best: "max" },
  { label: "GPQA", get: (m) => m.benchmarks?.gpqa, fmt: score, best: "max" },
  { label: "HLE", get: (m) => m.benchmarks?.hle, fmt: score, best: "max" },
  { label: "Output tokens/s", get: (m) => m.benchmarks?.outputTps, fmt: (v) => String(Math.round(v)), best: "max" },
  { label: "Time to first token", get: (m) => m.benchmarks?.ttft, fmt: (v) => `${v.toFixed(2)} s`, best: "min" },
  { label: "Input", get: (m) => m.inputModalities.join(", ") || "—" },
  { label: "Features", get: (m) => Object.entries(m.features).filter(([, v]) => v).map(([k]) => k).join(", ") || "—" },
  { label: "Tiers", get: (m) => (m.source === "nvidia" ? "NVIDIA (free)" : m.tiers.join(", ") || "—") },
  { label: "My spend (30 days)", get: (m) => (m.usage30d.requests ? m.usage30d.cost : undefined), fmt: (v) => usd(v) },
  { label: "My calls (all)", get: (m) => m.usageAll.requests || undefined, fmt: (v) => v.toLocaleString("en-US") },
];

export default function Compare({ models, onClose }: { models: CatalogModel[]; onClose: () => void }) {
  const [calls, setCalls] = useState(1000);
  const [inTok, setInTok] = useState(2000);
  const [outTok, setOutTok] = useState(500);
  const [cachePct, setCachePct] = useState(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const estimate = (m: CatalogModel): number | null => {
    if (m.priceIn === null || m.priceOut === null) return null;
    const cached = (inTok * cachePct) / 100;
    const cacheRate = m.priceCacheRead ?? m.priceIn;
    return (calls * ((inTok - cached) * m.priceIn + cached * cacheRate + outTok * m.priceOut)) / 1e6;
  };
  const ests = models.map(estimate);
  const minEst = Math.min(...ests.filter((x): x is number => x !== null));

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Compare models">
        <header>
          <h2>Compare {models.length} model{models.length === 1 ? "" : "s"}</h2>
          <button className="icon-btn" aria-label="Close compare" onClick={onClose}>✕</button>
        </header>
        <div className="body">
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                <tr>
                  <th></th>
                  {models.map((m) => (
                    <th key={m.slug} style={{ whiteSpace: "normal", color: "hsl(var(--foreground))" }}>
                      <div>{m.label}</div>
                      <div className="slug" style={{ marginTop: 4 }}><code>{m.apiId ?? m.slug}</code><CopyButton text={m.apiId ?? m.slug} /></div>
                      {m.source === "nvidia" && <span className="pill nvidia" style={{ marginTop: 4 }}>free · NVIDIA</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => {
                  const vals = models.map(r.get);
                  const nums = vals.filter((v): v is number => typeof v === "number");
                  const best = r.best && nums.length > 1 && new Set(nums).size > 1 ? (r.best === "min" ? Math.min(...nums) : Math.max(...nums)) : null;
                  if (vals.every((v) => v === undefined || v === null)) return null;
                  return (
                    <tr key={r.label}>
                      <td className="muted">{r.label}</td>
                      {vals.map((v, i) => (
                        <td key={i} className={`${typeof v === "number" ? "num" : ""}${best !== null && v === best ? " best" : ""}`} style={{ textAlign: typeof v === "number" ? "left" : undefined }}>
                          {v === undefined || v === null ? "—" : typeof v === "number" ? (r.fmt ? r.fmt(v) : v) : v}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <section className="card">
            <h3>Cost estimate for a workload</h3>
            <div className="estimator">
              <label>Calls<input className="input" type="number" min={1} value={calls} onChange={(e) => setCalls(Math.max(0, Number(e.target.value)))} /></label>
              <label>Input tokens per call<input className="input" type="number" min={0} value={inTok} onChange={(e) => setInTok(Math.max(0, Number(e.target.value)))} /></label>
              <label>Output tokens per call<input className="input" type="number" min={0} value={outTok} onChange={(e) => setOutTok(Math.max(0, Number(e.target.value)))} /></label>
              <label>Cached input share (%)<input className="input" type="number" min={0} max={100} value={cachePct} onChange={(e) => setCachePct(Math.min(100, Math.max(0, Number(e.target.value))))} /></label>
            </div>
            <table className="cmp" style={{ marginTop: 12 }}>
              <tbody>
                {models.map((m, i) => (
                  <tr key={m.slug}>
                    <td>{m.label}</td>
                    <td className={`num${ests[i] === minEst && models.length > 1 ? " best" : ""}`}>{ests[i] === null ? "no price" : usd(ests[i], 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="footnote" style={{ margin: "8px 0 0" }}>The estimate uses list prices. Reasoning tokens count as output tokens and can make the real cost higher.</p>
          </section>

          {models.map((m) => m.description && (
            <section key={m.slug}>
              <h3 style={{ margin: "0 0 6px", fontSize: 14 }}>{m.label}</h3>
              <p className="desc">{m.description}</p>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
