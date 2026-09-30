import { useEffect, useState } from "react";
import type { AvailabilityStatus, CatalogMeta, CatalogModel, Status, TestResult, UsageResponse } from "./types";

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string | { message?: string } };
    const msg = typeof j.error === "string" ? j.error : j.error?.message;
    throw new Error(msg ?? `${url} returned ${r.status}`);
  }
  return r.json() as Promise<T>;
}
const post = <T>(url: string, body: unknown) =>
  get<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const api = {
  status: () => get<Status>("/api/status"),
  catalog: (refresh = false) => get<{ models: CatalogModel[]; meta: CatalogMeta }>(`/api/catalog${refresh ? "?refresh=1" : ""}`),
  usage: (days: string) => get<UsageResponse>(`/api/usage?days=${days}`),
  availability: () => get<AvailabilityStatus>("/api/availability"),
  check: (slugs?: string[]) => post<{ job: unknown }>("/api/availability/check", { slugs }),
  test: (slug: string) => post<{ result: TestResult; text: string }>("/api/availability/test", { slug }),
  nvidiaTest: (id: string) => post<{ result: TestResult; text: string }>("/api/nvidia/test", { id }),
  link: (slug: string, orId: string | null) => post<{ ok: boolean }>("/api/models/link", { slug, orId }),
  orIds: () => get<{ id: string; name: string }[]>("/api/openrouter/ids"),
};

// Local UI preferences (favorites, columns, theme). This app runs on your own machine.
export function usePersistent<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}
