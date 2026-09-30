import { useMemo, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { CatalogMeta, CatalogModel } from "./types";
import { usePersistent } from "./api";
import { ago, perM, score, tokens, usd } from "./format";
import { CopyButton, InfoTip, SearchIcon, copyText } from "./ui";
import Compare from "./Compare";
import { AvailabilityBar, LinkEditor, StatusCell, useAvailability } from "./Availability";
import { benchInfo } from "./benchmarks";

type Scope = "available" | "all" | "fav" | "used" | "nvidia";
type ColMeta = { num?: boolean; title?: string; label?: string; info?: string };
const MATCH_TEXT: Record<string, string> = {
  alias: "Found by a known spelling difference (provider name, date suffix, -batch, ~router).",
  name: "Found by the same words in another order or spelling. Check that this is the right model.",
  endpoints: "Not in the OpenRouter model list. Found through the OpenRouter endpoints API.",
  manual: "Linked by hand.",
};
const FEATURES: { key: keyof CatalogModel["features"]; label: string }[] = [
  { key: "tools", label: "Tool calling" },
  { key: "structured", label: "Structured output" },
  { key: "reasoning", label: "Reasoning" },
  { key: "caching", label: "Prompt caching" },
  { key: "vision", label: "Image input" },
];
const CONTEXTS = [0, 32_000, 128_000, 200_000, 1_000_000];
const PRICE_STEPS = [0, 0.1, 0.5, 1, 2, 5, 10, 20, 50, Infinity];

const n = (v: number | null | undefined) => (v === null || v === undefined ? undefined : v);
const sortNum = { sortUndefined: "last" as const };

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export default function Catalog({ models, meta, loading, onReload }: { models: CatalogModel[]; meta: CatalogMeta | null; loading: boolean; onReload: () => void }) {
  const [q, setQ] = useState("");
  const [storedScope, setScope] = usePersistent<Scope | "mine">("cockpit:scope", "available");
  const nvidiaOn = !!meta?.nvidia?.enabled;
  // "mine" was the old name. The NVIDIA tab exists only with NVIDIA_API_KEY.
  const scope: Scope = storedScope === "mine" || (storedScope === "nvidia" && !nvidiaOn) ? "available" : storedScope;
  const turingModels = useMemo(() => models.filter((m) => m.source !== "nvidia"), [models]);
  const nvidiaModels = useMemo(() => models.filter((m) => m.source === "nvidia"), [models]);
  // The rows of the current tab, before search and filters.
  const base = scope === "nvidia" ? nvidiaModels : scope === "available" || scope === "all" ? turingModels : models;
  const avail = useAvailability(onReload);
  const [cats, setCats] = usePersistent<string[]>("cockpit:cats", []);
  const [tiers, setTiers] = usePersistent<string[]>("cockpit:tiers", []);
  const [feats, setFeats] = usePersistent<(keyof CatalogModel["features"])[]>("cockpit:feats", []);
  const [providers, setProviders] = usePersistent<string[]>("cockpit:providers", []);
  const [weights, setWeights] = usePersistent<"any" | "open" | "closed">("cockpit:weights", "any");
  const [maxPriceIdx, setMaxPriceIdx] = usePersistent<number>("cockpit:maxPrice", PRICE_STEPS.length - 1);
  const [minCtx, setMinCtx] = usePersistent<number>("cockpit:minCtx", 0);
  const [favs, setFavs] = usePersistent<string[]>("cockpit:favs", []);
  const [sorting, setSorting] = usePersistent<SortingState>("cockpit:sort", [{ id: "priceOut", desc: false }]);
  const [visibility, setVisibility] = usePersistent<VisibilityState>("cockpit:cols", { maxOutput: false, cacheWrite: false, math: false, gpqa: false, ttft: false });
  const [selected, setSelected] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = cats.length + tiers.length + feats.length + providers.length + (weights !== "any" ? 1 : 0) + (maxPriceIdx !== PRICE_STEPS.length - 1 ? 1 : 0) + (minCtx ? 1 : 0);

  const facet = useMemo(() => {
    const c = new Map<string, number>();
    const p = new Map<string, number>();
    const t = new Map<string, number>();
    for (const m of base) {
      m.categories.forEach((x) => c.set(x, (c.get(x) ?? 0) + 1));
      p.set(m.provider, (p.get(m.provider) ?? 0) + 1);
      m.tiers.forEach((x) => t.set(x, (t.get(x) ?? 0) + 1));
    }
    const sort = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { cats: sort(c), providers: sort(p), tiers: [...t.entries()].sort() };
  }, [base]);

  const maxPrice = PRICE_STEPS[maxPriceIdx];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return base.filter((m) => {
      if (scope === "available" && !m.available) return false;
      if (scope === "fav" && !favs.includes(m.slug)) return false;
      if (scope === "used" && m.usageAll.requests === 0) return false;
      if (needle && !`${m.label} ${m.name} ${m.slug} ${m.nvidiaAlt?.id ?? ""}`.toLowerCase().includes(needle)) return false;
      if (cats.length && !m.categories.some((c) => cats.includes(c))) return false;
      if (tiers.length && m.source !== "nvidia" && !m.tiers.some((t) => tiers.includes(t))) return false; // NVIDIA rows have no Turing tier
      if (providers.length && !providers.includes(m.provider)) return false;
      if (feats.some((f) => !m.features[f])) return false;
      if (weights === "open" && !m.openWeights) return false;
      if (weights === "closed" && m.openWeights) return false;
      if (maxPrice !== Infinity && (m.priceOut === null || m.priceOut > maxPrice)) return false;
      if (minCtx && (m.contextLength ?? 0) < minCtx) return false;
      return true;
    });
  }, [base, q, scope, favs, cats, tiers, providers, feats, weights, maxPrice, minCtx]);

  const columns = useMemo<ColumnDef<CatalogModel>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        enableHiding: false,
        header: () => <span className="sr-only">Select</span>,
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.label}`}
            checked={selected.includes(row.original.slug)}
            onChange={() => setSelected((s) => toggle(s, row.original.slug))}
            style={{ width: 15, height: 15, accentColor: "hsl(var(--primary))" }}
          />
        ),
      },
      {
        id: "fav",
        enableHiding: false,
        header: "Fav",
        accessorFn: (m) => (favs.includes(m.slug) ? 1 : 0),
        cell: ({ row }) => {
          const on = favs.includes(row.original.slug);
          return (
            <button className="star" aria-pressed={on} aria-label={on ? "Remove from favorites" : "Add to favorites"} onClick={() => setFavs(toggle(favs, row.original.slug))}>
              {on ? "★" : "☆"}
            </button>
          );
        },
      },
      {
        id: "model",
        header: "Model",
        enableHiding: false,
        accessorFn: (m) => m.label.toLowerCase(),
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="model-cell">
              <span className="name">
                {m.label}
                {m.source === "nvidia" && (
                  <a className="pill nvidia" style={{ marginLeft: 6 }} href={m.nvidiaUrl ?? "https://build.nvidia.com/models"} target="_blank" rel="noreferrer" title="Free Endpoint on build.nvidia.com. Opens the model page.">
                    free · NVIDIA
                  </a>
                )}
                {m.isNew && <span className="pill blue" style={{ marginLeft: 6 }} title={`Turing added this model ${ago(m.firstSeen)}`}>new</span>}
                {m.expirationDate && <span className="pill amber" style={{ marginLeft: 6 }} title="OpenRouter retires this model on this date. Calls fail after it.">retires {m.expirationDate.slice(0, 10)}</span>}
                {m.source !== "nvidia" && m.orStatus === "none" && <span className="pill amber" style={{ marginLeft: 6 }}>no OpenRouter match</span>}
                {m.source !== "nvidia" && m.orStatus === "unlisted" && <span className="pill amber" style={{ marginLeft: 6 }} title="The OpenRouter model list does not show it. The OpenRouter endpoints API still knows it.">not in OpenRouter list</span>}
              </span>
              <span className="slug"><code>{m.apiId ?? m.slug}</code><CopyButton text={m.apiId ?? m.slug} label={m.source === "nvidia" ? "Copy NVIDIA model id" : "Copy slug"} /></span>
              {m.nvidiaAlt && (
                <span className="slug small nvidia-text">
                  <span style={{ whiteSpace: "nowrap" }}>Free on NVIDIA:</span> <code>{m.nvidiaAlt.id}</code>
                  <CopyButton text={m.nvidiaAlt.id} label="Copy NVIDIA model id" />
                  <InfoTip label="About the free NVIDIA endpoint">
                    NVIDIA build hosts the same model as a free endpoint. Use base_url {location.origin}/api/nvidia/v1 and this model id. The cockpit adds your NVIDIA key. Free for development and testing, about 40 requests per minute.
                  </InfoTip>
                </span>
              )}
              {m.orId && (
                <span className="slug small muted">
                  OpenRouter: <code>{m.orId}</code><CopyButton text={m.orId} label="Copy OpenRouter id" />
                  {m.matchKind && MATCH_TEXT[m.matchKind] && (
                    <InfoTip label="How the cockpit found this OpenRouter id">
                      {MATCH_TEXT[m.matchKind]} Use this id in your code if the Turing slug fails.
                    </InfoTip>
                  )}
                  {m.matchKind === "name" && <span className="pill amber">check</span>}
                </span>
              )}
              {m.source !== "nvidia" && (m.orStatus !== "listed" || m.matchKind === "name" || m.matchKind === "manual") && <LinkEditor m={m} onDone={onReload} />}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        meta: { label: "Status", info: "status" },
        accessorFn: (m) => ({ available: 0, degraded: 1, unknown: 2, unavailable: 3 })[m.availability.state],
        cell: ({ row }) => (
          <StatusCell
            m={row.original}
            canTest={row.original.source === "nvidia" || !!avail.status?.keyConfigured}
            onTested={onReload}
          />
        ),
      },
      {
        id: "types",
        header: "Type",
        accessorFn: (m) => m.categories[0] ?? "",
        cell: ({ row }) => (
          <div className="tags">{(row.original.categories.length > 1 ? row.original.categories.filter((c) => c !== "Chat") : row.original.categories).map((c) => <span key={c} className={`pill${c === "Reasoning" || c === "Coding" ? " blue" : ""}`}>{c}</span>)}</div>
        ),
      },
      {
        id: "tiers",
        header: "Tier",
        accessorFn: (m) => (m.source === "nvidia" ? "nvidia" : m.tiers.join(",")),
        cell: ({ row }) => row.original.source === "nvidia" ? <div className="tags"><span className="pill nvidia">NVIDIA free</span></div> : <div className="tags">{row.original.tiers.map((t) => <span key={t} className={`pill${t === meta?.myTier ? " green" : ""}`} title={t === meta?.myTier ? "Your tier in the Turing usage tracker" : undefined}>{t}</span>)}</div>,
      },
      { id: "context", header: "Context", accessorFn: (m) => n(m.contextLength), sortDescFirst: true, ...sortNum, meta: { num: true }, cell: (c) => tokens(c.getValue() as number) },
      { id: "maxOutput", header: "Max out", accessorFn: (m) => n(m.maxOutput), sortDescFirst: true, ...sortNum, meta: { num: true }, cell: (c) => tokens(c.getValue() as number) },
      {
        id: "params",
        header: "Params",
        accessorFn: (m) => (m.params ? parseFloat(m.params) * (m.params.endsWith("M") ? 0.001 : 1) : undefined),
        sortDescFirst: true,
        ...sortNum,
        meta: { num: true },
        cell: ({ row }) => <span className={row.original.params ? "" : "muted"} title={row.original.params ? "From the model name" : row.original.openWeights ? "Open weights, but the name gives no size" : "The provider does not publish the size"}>{row.original.params ?? (row.original.openWeights ? "?" : "closed")}</span>,
      },
      { id: "priceIn", header: "In $/M", accessorFn: (m) => n(m.priceIn), ...sortNum, meta: { num: true }, cell: (c) => perM(c.getValue() as number ?? null) },
      { id: "priceOut", header: "Out $/M", accessorFn: (m) => n(m.priceOut), ...sortNum, meta: { num: true }, cell: (c) => <b>{perM(c.getValue() as number ?? null)}</b> },
      { id: "cacheRead", header: "Cache read $/M", accessorFn: (m) => n(m.priceCacheRead), ...sortNum, meta: { num: true }, cell: (c) => perM(c.getValue() as number ?? null) },
      { id: "cacheWrite", header: "Cache write $/M", accessorFn: (m) => n(m.priceCacheWrite), ...sortNum, meta: { num: true }, cell: (c) => perM(c.getValue() as number ?? null) },
      {
        id: "intelligence",
        header: "Intelligence",
        accessorFn: (m) => m.benchmarks?.intelligence,
        sortDescFirst: true,
        ...sortNum,
        meta: { num: true, info: "intelligence" },
        cell: ({ row }) => {
          const v = row.original.benchmarks?.intelligence;
          if (v === undefined) return <span className="muted">—</span>;
          const b = row.original.benchmarks!;
          return (
            <span className="bar-score" title={`Artificial Analysis Intelligence Index${b.indexVersion ? ` v${b.indexVersion}` : ""}, matched to "${b.aaName}" (${b.aaUrl})`}>
              <span className="track"><span style={{ width: `${Math.min(100, v)}%` }} /></span>
              {v.toFixed(1)}
            </span>
          );
        },
      },
      { id: "coding", header: "Coding", accessorFn: (m) => m.benchmarks?.coding, sortDescFirst: true, ...sortNum, meta: { num: true, info: "coding" }, cell: (c) => score(c.getValue() as number | undefined) },
      { id: "agentic", header: "Agentic", accessorFn: (m) => m.benchmarks?.agentic, sortDescFirst: true, ...sortNum, meta: { num: true, info: "agentic" }, cell: (c) => score(c.getValue() as number | undefined) },
      { id: "math", header: "Math", accessorFn: (m) => m.benchmarks?.math, sortDescFirst: true, ...sortNum, meta: { num: true, info: "math" }, cell: (c) => score(c.getValue() as number | undefined) },
      { id: "gpqa", header: "GPQA", accessorFn: (m) => m.benchmarks?.gpqa, sortDescFirst: true, ...sortNum, meta: { num: true, info: "gpqa" }, cell: (c) => score(c.getValue() as number | undefined) },
      {
        id: "value",
        header: "Value",
        accessorFn: (m) => (m.benchmarks?.intelligence !== undefined && m.priceOut ? m.benchmarks.intelligence / Math.max(0.01, m.priceOut) : undefined),
        sortDescFirst: true,
        ...sortNum,
        meta: { num: true, info: "value" },
        cell: (c) => (c.getValue() === undefined ? <span className="muted">—</span> : (c.getValue() as number).toFixed(1)),
      },
      { id: "speed", header: "Tok/s", accessorFn: (m) => m.benchmarks?.outputTps, sortDescFirst: true, ...sortNum, meta: { num: true, info: "speed" }, cell: (c) => (c.getValue() === undefined ? "—" : Math.round(c.getValue() as number)) },
      { id: "ttft", header: "TTFT s", accessorFn: (m) => m.benchmarks?.ttft, ...sortNum, meta: { num: true, info: "ttft" }, cell: (c) => (c.getValue() === undefined ? "—" : (c.getValue() as number).toFixed(2)) },
      {
        id: "spend30",
        header: "My 30d",
        accessorFn: (m) => (m.usage30d.requests ? m.usage30d.cost : undefined),
        sortDescFirst: true,
        ...sortNum,
        meta: { num: true, title: "Your spend on this model in the last 30 days (calls through the cockpit proxy)" },
        cell: ({ row }) => (row.original.usage30d.requests ? <span className="spend">{usd(row.original.usage30d.cost)}</span> : <span className="muted">—</span>),
      },
      {
        id: "requests",
        header: "My calls",
        accessorFn: (m) => (m.usageAll.requests || undefined),
        sortDescFirst: true,
        ...sortNum,
        meta: { num: true },
        cell: (c) => (c.getValue() === undefined ? <span className="muted">—</span> : (c.getValue() as number).toLocaleString("en-US")),
      },
    ],
    [favs, selected, meta?.myTier, setFavs, avail.status?.keyConfigured, onReload],
  );

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: (u) => setSorting(typeof u === "function" ? u(sorting) : u),
    onColumnVisibilityChange: (u) => setVisibility(typeof u === "function" ? u(visibility) : u),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (m) => m.slug,
  });

  const counts = {
    available: turingModels.filter((m) => m.available).length,
    all: turingModels.length,
    nvidia: nvidiaModels.length,
    fav: models.filter((m) => favs.includes(m.slug)).length,
    used: models.filter((m) => m.usageAll.requests > 0).length,
  };
  const resetFilters = () => {
    setCats([]); setTiers([]); setFeats([]); setProviders([]); setWeights("any"); setMaxPriceIdx(PRICE_STEPS.length - 1); setMinCtx(0); setQ("");
  };
  const selModels = models.filter((m) => selected.includes(m.slug));

  return (
    <div className="catalog">
      <aside className={`filters${filtersOpen ? " open" : ""}`} id="filters" aria-label="Filters">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b>Filters</b>
          <button className="btn ghost" style={{ height: 30 }} onClick={resetFilters}>Reset</button>
        </div>
        <section>
          <h3>Type</h3>
          {facet.cats.map(([c, count]) => (
            <label key={c} className="check"><input type="checkbox" checked={cats.includes(c)} onChange={() => setCats(toggle(cats, c))} /><span>{c}</span><span className="count">{count}</span></label>
          ))}
        </section>
        {facet.tiers.length > 0 && (
          <section>
            <h3>Turing tier</h3>
            {facet.tiers.map(([t, count]) => (
              <label key={t} className="check"><input type="checkbox" checked={tiers.includes(t)} onChange={() => setTiers(toggle(tiers, t))} /><span><span style={{ textTransform: "capitalize" }}>{t}</span>{t === meta?.myTier ? " (your tier)" : ""}</span><span className="count">{count}</span></label>
            ))}
          </section>
        )}
        <section>
          <h3>Features (all must match)</h3>
          {FEATURES.map((f) => (
            <label key={f.key} className="check"><input type="checkbox" checked={feats.includes(f.key)} onChange={() => setFeats(toggle(feats, f.key))} /><span>{f.label}</span><span className="count">{base.filter((m) => m.features[f.key]).length}</span></label>
          ))}
        </section>
        <section className="field">
          <h3>Weights</h3>
          <div className="seg" role="group" aria-label="Weights">
            {(["any", "open", "closed"] as const).map((w) => <button key={w} aria-pressed={weights === w} onClick={() => setWeights(w)} style={{ flex: 1, textTransform: "capitalize" }}>{w}</button>)}
          </div>
        </section>
        <section className="field">
          <h3 id="maxp">Max output price per 1M</h3>
          <input type="range" min={0} max={PRICE_STEPS.length - 1} value={maxPriceIdx} onChange={(e) => setMaxPriceIdx(Number(e.target.value))} aria-labelledby="maxp" style={{ accentColor: "hsl(var(--primary))" }} />
          <span className="small muted">{maxPrice === Infinity ? "Any price" : `Up to $${maxPrice}`}</span>
        </section>
        <section className="field">
          <h3 id="minc">Min context</h3>
          <select className="select" value={minCtx} onChange={(e) => setMinCtx(Number(e.target.value))} aria-labelledby="minc">
            {CONTEXTS.map((c) => <option key={c} value={c}>{c ? tokens(c) : "Any"}</option>)}
          </select>
        </section>
        <section>
          <h3>Provider</h3>
          {facet.providers.map(([p, count]) => (
            <label key={p} className="check"><input type="checkbox" checked={providers.includes(p)} onChange={() => setProviders(toggle(providers, p))} /><span>{p}</span><span className="count">{count}</span></label>
          ))}
        </section>
      </aside>

      <main className="main">
        <div className="toolbar">
          <button className="btn filters-toggle" aria-expanded={filtersOpen} aria-controls="filters" onClick={() => setFiltersOpen(!filtersOpen)}>
            Filters{activeFilters ? ` (${activeFilters})` : ""}
          </button>
          <div className="search">
            <SearchIcon />
            <input className="input" type="search" placeholder="Search name or slug" aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="seg" role="group" aria-label="Show">
            <button aria-pressed={scope === "available"} onClick={() => setScope("available")} title="Models that the checks do not mark as broken">Available models · {counts.available}</button>
            <button aria-pressed={scope === "all"} onClick={() => setScope("all")} title="All models on the Turing College list, also the broken ones">{meta?.tierSource === "turing" ? "All Turing models" : "All models"} · {counts.all}</button>
            <button aria-pressed={scope === "fav"} onClick={() => setScope("fav")}>Favorites · {counts.fav}</button>
            <button aria-pressed={scope === "used"} onClick={() => setScope("used")}>Used by me · {counts.used}</button>
            {nvidiaOn && (
              <button aria-pressed={scope === "nvidia"} className="seg-nvidia" onClick={() => setScope("nvidia")} title="Free endpoints from NVIDIA build (NVIDIA_API_KEY in .env)">
                NVIDIA free · {counts.nvidia}
              </button>
            )}
          </div>
          <div className="spacer" />
          <span className="small muted">{filtered.length} shown</span>
          {meta?.tierSource === "turing" && scope !== "nvidia" && <AvailabilityBar models={turingModels} avail={avail} />}
          <div className="menu">
            <button className="btn" aria-expanded={colsOpen} onClick={() => setColsOpen(!colsOpen)}>Columns</button>
            {colsOpen && (
              <div className="menu-panel">
                {table.getAllLeafColumns().filter((c) => c.getCanHide()).map((c) => (
                  <label key={c.id} className="check"><input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()} /><span>{(c.columnDef.meta as ColMeta | undefined)?.label ?? String(c.columnDef.header)}</span></label>
                ))}
              </div>
            )}
          </div>
        </div>

        {scope === "nvidia" && meta?.nvidia && <NvidiaBanner info={meta.nvidia} />}
        <div className="table-wrap">
          <table>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => {
                    const m = h.column.columnDef.meta as ColMeta | undefined;
                    const s = h.column.getIsSorted();
                    const info = m?.info ? benchInfo(m.info, meta) : null;
                    return (
                      <th key={h.id} className={m?.num ? "num" : ""} aria-sort={s === "asc" ? "ascending" : s === "desc" ? "descending" : undefined} title={m?.title}>
                        <span className="th-inner">
                          {h.column.getCanSort() ? (
                            <button onClick={h.column.getToggleSortingHandler()}>
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              <span aria-hidden="true">{s === "asc" ? "↑" : s === "desc" ? "↓" : ""}</span>
                            </button>
                          ) : (
                            flexRender(h.column.columnDef.header, h.getContext())
                          )}
                          {info && <InfoTip label={`About ${String(h.column.columnDef.header)}`} width={340}>{info}</InfoTip>}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((r) => (
                <tr key={r.id} className={`${selected.includes(r.id) ? "selected" : ""}${r.original.available ? "" : " unavailable"}`}>
                  {r.getVisibleCells().map((c) => {
                    const m = c.column.columnDef.meta as { num?: boolean } | undefined;
                    return <td key={c.id} className={m?.num ? "num" : ""}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <div className="empty">{loading ? "Loading models…" : "No model matches these filters. Click Reset to clear them."}</div>}
        </div>

        <p className="footnote">
          Prices from the OpenRouter API ({ago(meta?.orUpdatedAt)}), in USD per 1M tokens.{" "}
          {meta?.aaEnabled && meta.aaStatus && !meta.aaStatus.ok ? (
            <span className="warn-text">Benchmarks: the Artificial Analysis API failed ({meta.aaStatus.error}). The cockpit tries again in 1 hour. Check <code>AA_API_KEY</code> in <code>.env</code>.</span>
          ) : meta?.aaEnabled ? (
            <>Benchmarks from <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis</a> ({ago(meta.aaUpdatedAt)}{meta.aaStatus?.version ? `, Intelligence Index v${meta.aaStatus.version}` : ""}; <a href="https://artificialanalysis.ai/methodology/intelligence-benchmarking" target="_blank" rel="noreferrer">methodology</a>). {meta.aaMatched} of {models.length} models have a score. The cockpit matches models by name, so some models have no score.</>
          ) : (
            <>Benchmark indexes come from the OpenRouter model list (data from <a href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis</a>; <a href="https://artificialanalysis.ai/methodology/intelligence-benchmarking" target="_blank" rel="noreferrer">methodology</a>). {meta?.aaMatched ?? 0} of {models.length} models have a score. For speed and time to first token, add a free <code>AA_API_KEY</code> to <code>.env</code> and restart the server.</>
          )}{" "}
          Parameter counts come from the model name. Closed models do not publish them. "My" columns count calls through the cockpit proxy.
        </p>
      </main>

      {selected.length > 0 && (
        <div className="selbar" role="region" aria-label="Selection">
          <span>{selected.length} selected</span>
          <button className="btn primary" onClick={() => setCompareOpen(true)} disabled={selected.length < 1}>Compare</button>
          <button className="btn" onClick={() => void copyText(JSON.stringify(selected, null, 2))}>Copy slugs as JSON</button>
          <button className="btn ghost" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}
      {compareOpen && <Compare models={selModels} onClose={() => setCompareOpen(false)} />}
    </div>
  );
}

// Explains the NVIDIA tab: where the list comes from, how to call the models, and the limits.
function NvidiaBanner({ info }: { info: CatalogMeta["nvidia"] }) {
  const baseUrl = `${location.origin}/api/nvidia/v1`;
  const snippet = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",   # the cockpit adds your NVIDIA_API_KEY
    api_key="unused",
)
client.chat.completions.create(model="z-ai/glm-5.3", messages=[{"role": "user", "content": "Hi"}])`;
  return (
    <div className="card nvidia-card">
      <div className="nvidia-card-head">
        <span className="pill nvidia">NVIDIA build</span>
        <b>Free models from build.nvidia.com</b>
        <span className="small muted">
          {info.count} chat and embedding models of {info.freeTotal} "Free Endpoint" entries (the others are speech, video and other APIs) · list checked {ago(info.updatedAt)}
        </span>
      </div>
      {info.error && <p className="small warn-text" style={{ margin: "6px 0 0" }}>The last update failed ({info.error}). The table shows the last list.</p>}
      <p className="small" style={{ margin: "8px 0 0" }}>
        Call them through the cockpit with{" "}
        <span className="slug" style={{ verticalAlign: "middle" }}>
          <code>base_url={baseUrl}</code>
          <CopyButton text={baseUrl} label="Copy base URL" />
        </span>{" "}
        and the model id from the table. The cockpit adds your
        NVIDIA key and logs each call with cost $0. Free for development and testing only; the rate limit is about 40 requests per minute. Benchmark scores come from the
        same model on OpenRouter.
      </p>
      <details className="small" style={{ marginTop: 6 }}>
        <summary>Python example</summary>
        <pre className="snippet">{snippet}</pre>
        <CopyButton text={snippet} label="Copy example" />
      </details>
    </div>
  );
}
