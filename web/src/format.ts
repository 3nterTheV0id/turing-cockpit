export const usd = (n: number | null | undefined, digits?: number): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  const d = digits ?? (Math.abs(n) < 0.01 ? 4 : 2);
  return `$${n.toFixed(d)}`;
};
export const perM = (n: number | null): string => (n === null ? "—" : n === 0 ? "$0" : usd(n, n < 1 ? 3 : 2));
export const tokens = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
};
export const int = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
export const score = (n: number | undefined): string => (n === undefined ? "—" : n <= 1 ? `${Math.round(n * 100)}%` : n.toFixed(1));
export const ago = (ts: number | null | undefined): string => {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
export const shortSlug = (s: string): string => s.replace(/^[^/]+\//, "");
