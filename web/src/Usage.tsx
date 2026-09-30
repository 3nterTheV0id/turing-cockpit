import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { api, usePersistent } from "./api";
import type { CatalogModel, Learner, UsageResponse } from "./types";
import { ago, int, shortSlug, tokens, usd } from "./format";
import { CopyButton } from "./ui";

const SERIES = ["hsl(210 100% 52%)", "hsl(38 92% 50%)", "hsl(142 71% 45%)", "hsl(280 70% 65%)", "hsl(190 80% 50%)"];
const OTHER = "hsl(240 5% 45%)";
const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 12 };

export default function Usage({ models, learner }: { models: CatalogModel[]; learner: Learner | null }) {
  const [range, setRange] = usePersistent<"7" | "30" | "all">("cockpit:range", "30");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.usage(range).then((d) => live && (setData(d), setErr(null))).catch((e: Error) => live && setErr(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [range]);

  const top = useMemo(() => (data?.byModel ?? []).slice(0, SERIES.length).map((m) => m.model), [data]);

  const daily = useMemo(() => {
    const days = new Map<string, Record<string, number | string>>();
    // Local date (the server groups the proxy log by local day too). toISOString() would give the UTC date.
    const localDay = (t: number) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const cutoff = range === "all" ? "" : localDay(Date.now() - Number(range) * 86400000);
    for (const d of data?.daily ?? []) {
      const row = days.get(d.day) ?? { day: d.day };
      const key = top.includes(d.model) ? d.model : "other";
      row[key] = ((row[key] as number) ?? 0) + d.cost;
      days.set(d.day, row);
    }
    for (const p of learner?.dailyUsage ?? []) {
      const day = p.date.slice(0, 10);
      if (day < cutoff) continue;
      const row = days.get(day) ?? { day };
      row.turing = p.amount;
      days.set(day, row);
    }
    return [...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [data, top, learner, range]);

  const t = data?.totals;
  const cacheRate = t && t.prompt ? (t.cached / t.prompt) * 100 : null;
  const maxModelCost = Math.max(0.000001, ...(data?.byModel ?? []).map((m) => m.cost));
  const bySlug = useMemo(() => new Map(models.map((m) => [m.slug, m])), [models]);
  const hasOther = (data?.byModel.length ?? 0) > SERIES.length;
  const creditPct = learner?.usage !== undefined && learner.limit ? (learner.usage / learner.limit) * 100 : null;
  const creditState = creditPct === null ? null : creditPct >= 100 ? "Expired" : creditPct >= 80 ? "Near limit" : "Active";

  const scatter = useMemo(
    () =>
      models
        .filter((m) => m.available && m.benchmarks?.intelligence !== undefined && m.priceOut)
        .map((m) => ({ x: m.priceOut as number, y: m.benchmarks!.intelligence as number, z: m.usageAll.requests ? 120 : 50, name: m.label, slug: m.slug, used: m.usageAll.requests > 0 })),
    [models],
  );
  const priceTicks = useMemo(() => {
    const all = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100];
    if (!scatter.length) return [0.1, 1, 10];
    const lo = Math.min(...scatter.map((s) => s.x));
    const hi = Math.max(...scatter.map((s) => s.x));
    const i0 = Math.max(0, all.findIndex((t) => t > lo) - 1);
    const i1 = all.findIndex((t) => t >= hi);
    return all.slice(i0, (i1 < 0 ? all.length - 1 : i1) + 1);
  }, [scatter]);

  return (
    <div className="usage">
      <div className="toolbar">
        <h2 style={{ margin: 0, fontSize: 20 }}>My usage</h2>
        <div className="seg" role="group" aria-label="Time range">
          {(["7", "30", "all"] as const).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{r === "all" ? "All time" : `${r} days`}</button>
          ))}
        </div>
        <div className="spacer" />
        {data?.firstLogged && <span className="small muted">Proxy log since {new Date(data.firstLogged).toLocaleDateString()}</span>}
      </div>
      {err && <div className="banner warn" style={{ margin: 0 }}><p>{err}</p></div>}

      <div className="kpis">
        <div className="card kpi">
          <div className="label">Turing credit used</div>
          <div className="value">{learner ? usd(learner.usage, 2) : "—"}</div>
          <div className="note">
            {learner ? <>of {usd(learner.limit, 2)} · {creditState} {learner.lastUpdated && `· Turing updated ${ago(Date.parse(learner.lastUpdated))}`}</> : "Sync the extension with your email"}
          </div>
        </div>
        <div className="card kpi"><div className="label">Logged spend</div><div className="value">{usd(t?.cost ?? 0, 2)}</div><div className="note">{t?.pendingCost ? `${t.pendingCost} calls wait for a cost` : "Calls through the proxy"}</div></div>
        <div className="card kpi"><div className="label">Requests</div><div className="value">{int(t?.requests ?? 0)}</div><div className="note">{data?.byModel.length ?? 0} models{data?.nvidiaRequests ? ` · ${int(data.nvidiaRequests)} free via NVIDIA` : ""}</div></div>
        <div className="card kpi"><div className="label">Tokens</div><div className="value">{tokens((t?.prompt ?? 0) + (t?.completion ?? 0))}</div><div className="note">{tokens(t?.prompt ?? 0)} in · {tokens(t?.completion ?? 0)} out{t?.reasoning ? ` · ${tokens(t.reasoning)} reasoning` : ""}</div></div>
        <div className="card kpi"><div className="label">Cache hit rate</div><div className="value">{cacheRate === null ? "—" : `${cacheRate.toFixed(0)}%`}</div><div className="note">Share of input tokens read from cache</div></div>
        <div className="card kpi"><div className="label">Top model</div><div className="value" style={{ fontSize: 16, lineHeight: "30px" }}>{data?.byModel[0] ? shortSlug(data.byModel[0].model) : "—"}</div><div className="note">{data?.byModel[0] && t?.cost ? `${((data.byModel[0].cost / t.cost) * 100).toFixed(0)}% of logged spend` : ""}</div></div>
      </div>

      {data && data.totals.requests === 0 && (
        <div className="card">
          <h3>Start to log calls per model</h3>
          <p style={{ margin: 0 }}>Set the base URL in your course code to the cockpit proxy. Keep your key as it is. The proxy forwards each call to OpenRouter and saves the model, tokens and cost on this computer.</p>
          <pre className="snippet">{`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8787/api/v1",   # was https://openrouter.ai/api/v1
    api_key=os.environ["OPENROUTER_API_KEY"],
)`}</pre>
          <p className="footnote" style={{ margin: "8px 0 0" }}>For LangChain, use <code>base_url=</code> on <code>ChatOpenAI</code>. For plain HTTP, send requests to <code>http://localhost:8787/api/v1/chat/completions</code>.</p>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>Daily spend by model</h3>
          <div style={{ height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={daily} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" tick={axis} tickLine={false} axisLine={false} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis tick={axis} tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--secondary) / 0.5)" }}
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12.5 }}
                  formatter={(v: number, k: string) => [usd(v), k === "turing" ? "Turing total (all calls)" : shortSlug(k)]}
                />
                <Legend formatter={(k: string) => (k === "turing" ? "Turing total" : shortSlug(k))} wrapperStyle={{ fontSize: 12 }} />
                {top.map((m, i) => <Bar key={m} dataKey={m} stackId="a" fill={SERIES[i]} maxBarSize={28} />)}
                {hasOther && <Bar dataKey="other" stackId="a" fill={OTHER} maxBarSize={28} />}
                {(learner?.dailyUsage?.length ?? 0) > 0 && <Line dataKey="turing" type="linear" stroke="hsl(var(--foreground))" strokeDasharray="4 3" dot={false} strokeWidth={1.5} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="footnote" style={{ margin: "6px 0 0" }}>Bars: calls through the proxy. Dashed line: daily total that Turing College reports for your key (all calls).</p>
        </div>
        <div className="card">
          <h3>Spend by model</h3>
          {(data?.byModel ?? []).slice(0, 10).map((m) => (
            <div key={m.model} className="hbar" title={`${m.requests} calls · ${tokens(m.prompt + m.completion)} tokens`}>
              <code>{m.model}</code>
              <span className="track"><span style={{ width: `${(m.cost / maxModelCost) * 100}%` }} /></span>
              <span className="num">{usd(m.cost)}</span>
            </div>
          ))}
          {!data?.byModel.length && <p className="muted" style={{ margin: 0 }}>No calls in this range.</p>}
        </div>
      </div>

      <div className="grid-2b">
        <div className="card">
          <h3>Value map</h3>
          {scatter.length ? (
            <>
              <div style={{ height: 280 }}>
                <ResponsiveContainer>
                  <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                    <CartesianGrid stroke="hsl(var(--border))" />
                    <XAxis type="number" dataKey="x" scale="log" domain={[priceTicks[0], priceTicks[priceTicks.length - 1]]} ticks={priceTicks} tick={axis} tickFormatter={(v: number) => `$${v}`} name="Output $/M" allowDataOverflow />
                    <YAxis type="number" dataKey="y" tick={axis} width={36} name="Intelligence" />
                    <ZAxis type="number" dataKey="z" range={[40, 130]} />
                    <Tooltip
                      cursor={{ strokeDasharray: "3 3" }}
                      content={({ payload }) => {
                        const p = payload?.[0]?.payload as (typeof scatter)[number] | undefined;
                        return p ? <div className="tt"><b>{p.name}</b><br />Output ${p.x}/M · Intelligence {p.y.toFixed(1)}{p.used ? " · used by you" : ""}</div> : null;
                      }}
                    />
                    <Scatter data={scatter.filter((s) => !s.used)} fill="hsl(var(--muted-foreground))" />
                    <Scatter data={scatter.filter((s) => s.used)} fill="hsl(var(--primary))" />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <p className="footnote" style={{ margin: 0 }}>Models to the top left give more intelligence per dollar. Blue points are models that you used.</p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>The value map needs benchmark scores. Add <code>AA_API_KEY</code> to <code>.env</code> and restart the server.</p>
          )}
        </div>
        <div className="card" style={{ overflowX: "auto" }}>
          <h3>Recent requests</h3>
          <table>
            <thead>
              <tr><th>Time</th><th>Model</th><th className="num">In</th><th className="num">Out</th><th className="num">Cached</th><th className="num">Latency</th><th className="num">Cost</th></tr>
            </thead>
            <tbody>
              {(data?.recent ?? []).slice(0, 12).map((r) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.ts).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td><span className="slug"><code>{shortSlug(r.model.replace(/^nim:/, ""))}</code>{r.model.startsWith("nim:") && <span className="pill nvidia">NVIDIA</span>}{bySlug.has(r.model) && <CopyButton text={r.model} />}</span></td>
                  <td className="num">{int(r.prompt_tokens)}</td>
                  <td className="num">{int(r.completion_tokens)}</td>
                  <td className="num">{int(r.cached_tokens)}</td>
                  <td className="num">{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)} s` : "—"}</td>
                  <td className="num spend">{r.cost === null ? <span className="muted">pending</span> : usd(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.recent.length && <p className="muted">No requests yet.</p>}
        </div>
      </div>
    </div>
  );
}
