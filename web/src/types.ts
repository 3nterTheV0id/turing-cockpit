export interface Benchmarks {
  source: string;
  aaSlug: string;
  aaName: string;
  aaUrl: string;
  indexVersion?: string;
  intelligence?: number;
  coding?: number;
  math?: number;
  agentic?: number;
  gpqa?: number;
  hle?: number;
  mmluPro?: number;
  livecodebench?: number;
  outputTps?: number;
  ttft?: number;
}
export interface UsageAgg { requests: number; cost: number; tokens: number }
export type AvailState = "available" | "unavailable" | "degraded" | "unknown";
export interface Availability {
  state: AvailState;
  label: string;
  detail: string;
  source: "key" | "openrouter" | "none";
  checkedAt: number | null;
}
export interface ProviderInfo {
  provider: string;
  slug: string;
  status: number | null;
  quantization: string | null;
  contextLength: number | null;
  maxOutput: number | null;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  uptime5m: number | null;
  uptime30m: number | null;
  uptime1d: number | null;
  latency30m: number | null;
  throughput30m: number | null;
  tools: boolean;
  implicitCaching: boolean;
}
export type TestVerdict = "ok" | "invalid" | "no-endpoints" | "blocked" | "bad-request" | "transient" | "auth" | "no-credit" | "skipped";
export interface TestResult {
  verdict: TestVerdict;
  status: number | null;
  message: string;
  latencyMs: number | null;
  cost: number | null;
  works: string | null;
  tried: string[];
  at: number;
}
export type MatchKind = "manual" | "exact" | "alias" | "name" | "endpoints";
export interface CatalogModel {
  source: "turing" | "nvidia";
  apiId: string | null;
  nvidiaUrl: string | null;
  nvidiaAlt: { id: string; url: string } | null;
  slug: string;
  orId: string | null;
  matchKind: MatchKind | null;
  orStatus: "listed" | "unlisted" | "none";
  label: string;
  name: string;
  provider: string;
  description: string;
  tiers: string[];
  inMyTier: boolean;
  available: boolean;
  availability: Availability;
  providers: ProviderInfo[];
  lastTest: { verdict: TestVerdict; at: number; latencyMs: number | null; cost: number | null; works: string | null; text: string } | null;
  test: { possible: boolean; estCost: number; note: string | null };
  expirationDate: string | null;
  isNew: boolean;
  firstSeen: number | null;
  inOpenRouter: boolean;
  categories: string[];
  inputModalities: string[];
  outputModalities: string[];
  contextLength: number | null;
  maxOutput: number | null;
  params: string | null;
  openWeights: boolean;
  priceIn: number | null;
  priceOut: number | null;
  priceCacheRead: number | null;
  priceCacheWrite: number | null;
  priceReasoning: number | null;
  priceRequest: number | null;
  features: { tools: boolean; structured: boolean; reasoning: boolean; caching: boolean; vision: boolean };
  created: number | null;
  benchmarks: Benchmarks | null;
  usage30d: UsageAgg;
  usageAll: UsageAgg;
}
export interface AAStatus {
  ok: boolean;
  at: number;
  count: number;
  version: string | null;
  error: string | null;
}
export interface CatalogMeta {
  orUpdatedAt: number | null;
  aaEnabled: boolean;
  aaUpdatedAt: number | null;
  aaStatus: AAStatus | null;
  aaMatched: number;
  tierSource: "turing" | "openrouter";
  myTier: string | null;
  nvidia: { enabled: boolean; count: number; freeTotal: number; updatedAt: number | null; error: string | null };
}
export interface Learner {
  keyName?: string;
  batch?: string;
  firstName?: string;
  usage?: number;
  limit?: number;
  lastUpdated?: string;
  tier?: string;
  notificationThreshold?: number;
  dailyUsage?: { date: string; amount: number }[];
}
export interface Status {
  ok: boolean;
  port: number;
  turingSyncedAt: number | null;
  tiers: { name: string; count: number; updatedAt?: string }[];
  learner: Learner | null;
  aaEnabled: boolean;
  keyConfigured: boolean;
  nvidiaEnabled: boolean;
}
export interface UsageResponse {
  totals: { requests: number; cost: number; prompt: number; completion: number; cached: number; reasoning: number; first: number | null; pendingCost: number | null };
  byModel: { model: string; requests: number; cost: number; prompt: number; completion: number; cached: number }[];
  daily: { day: string; model: string; cost: number; requests: number }[];
  recent: { id: string; ts: number; model: string; provider: string | null; prompt_tokens: number; completion_tokens: number; cached_tokens: number; reasoning_tokens: number; cost: number | null; latency_ms: number | null; streamed: number }[];
  firstLogged: number | null;
  nvidiaRequests: number;
  turing: Learner | null;
}

export interface Job {
  kind: "free";
  total: number;
  done: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}
export interface AvailabilityStatus {
  job: Job | null;
  keyConfigured: boolean;
  lastFreeAt: number | null;
  keyModelsAt: number | null;
  keyModelsCount: number | null;
}
