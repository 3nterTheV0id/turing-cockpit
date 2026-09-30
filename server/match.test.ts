// Matching of Turing slugs to OpenRouter ids, with the real lists from September 2026
// (fixtures/openrouter-ids-2026-09.txt: 625 OpenRouter ids; fixtures/turing-slugs-2026-09.txt: 59 Turing slugs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIdIndex, nameKey, resolveWithKind, slugVariants } from "./match.ts";

const here = new URL("./fixtures/", import.meta.url);
const orModels = readFileSync(new URL("openrouter-ids-2026-09.txt", here), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [id, canonical] = l.split(" ");
    return { id, canonical_slug: canonical ?? id, name: id };
  });
const turing = readFileSync(new URL("turing-slugs-2026-09.txt", here), "utf8").split("\n").filter(Boolean);
const byId = buildIdIndex(orModels);

test("all real Turing slugs resolve as checked by hand (Sept 2026)", () => {
  const expected: Record<string, string> = {
    "anthropic/claude-sonnet-latest": "~anthropic/claude-sonnet-latest",
    "deepseek/deepseek-flash-latest": "~deepseek/deepseek-flash-latest",
    "google/gemini-flash-latest": "~google/gemini-flash-latest",
    "google/gemma-4-31b-it-20260402": "google/gemma-4-31b-it",
    "openai/gpt-mini-latest": "~openai/gpt-mini-latest",
    "typesafe/jev-latest": "~typesafe/jev-latest",
    "deepseek/deepseek-v4-flash-0423": "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro-0423": "deepseek/deepseek-v4-pro",
    "google/gemini-3.7-flash-batch": "google/gemini-3.7-flash:batch",
    "rerank/rerank-4-fast": "cohere/rerank-4-fast",
    "rerank/rerank-4-pro": "cohere/rerank-4-pro",
    "xai/grok-4.5": "x-ai/grok-4.5",
  };
  const missing: string[] = [];
  for (const slug of turing) {
    const { model } = resolveWithKind(slug, byId);
    if (!model) {
      missing.push(slug);
      continue;
    }
    assert.equal(model.id, expected[slug] ?? slug, `wrong match for ${slug}`);
  }
  // Not in the OpenRouter list (the page exists, but with 0 providers). The availability check marks it "Retired".
  assert.deepEqual(missing, ["anthropic/claude-3.5-haiku"]);
});

test("new Turing spellings still find the right OpenRouter model", () => {
  const cases: [string, string, string][] = [
    ["anthropic/claude-4.5-haiku", "anthropic/claude-haiku-4.5", "name"], // other word order
    ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4.5", "name"], // "-" instead of "."
    ["Anthropic/Claude-Haiku-4.5", "anthropic/claude-haiku-4.5", "name"], // capitals
    ["xai/grok-4.5-0901", "x-ai/grok-4.5", "alias"], // provider alias + short date
    ["google/gemini-3.7-flash-20260901", "google/gemini-3.7-flash", "alias"], // long date
    ["google/gemini-3-7-flash-batch", "google/gemini-3.7-flash:batch", "name"], // no ".", batch variant
    ["google/gemini-3-7-flash-free", "google/gemini-3.7-flash", "name"], // no ":free" variant: the base model
    ["openai/gpt-5-4-mini", "openai/gpt-5.4-mini", "name"],
    ["x-ai/grok-4.5", "x-ai/grok-4.5", "exact"],
  ];
  for (const [slug, id, kind] of cases) {
    const r = resolveWithKind(slug, byId);
    assert.equal(r.model?.id, id, slug);
    assert.equal(r.kind, kind, slug);
  }
});

test("no guess when the words are not the same or not unique", () => {
  // gpt-5.4 must not become gpt-5.4-mini, and claude-3.5-haiku must not become claude-3-haiku.
  assert.equal(resolveWithKind("openai/gpt-5-4", byId).model?.id, "openai/gpt-5.4");
  assert.equal(resolveWithKind("anthropic/claude-3.5-haiku", byId).model, undefined);
  assert.equal(resolveWithKind("openai/gpt-99-ultra", byId).model, undefined);
  assert.equal(resolveWithKind("mystery/model", byId).model, undefined);
});

test("a manual link wins", () => {
  const r = resolveWithKind("anthropic/claude-3.5-haiku", byId, { "anthropic/claude-3.5-haiku": "anthropic/claude-haiku-4.5" });
  assert.equal(r.model?.id, "anthropic/claude-haiku-4.5");
  assert.equal(r.kind, "manual");
});

test("nameKey and slugVariants", () => {
  assert.equal(nameKey("claude-3-5-haiku"), nameKey("anthropic/claude-3.5-haiku"));
  assert.equal(nameKey("claude-haiku-4.5"), nameKey("claude-4.5-haiku-20251001"));
  assert.notEqual(nameKey("gpt-5.4"), nameKey("gpt-5.4-mini"));
  const v = slugVariants("xai/grok-4.5-batch");
  assert.ok(v.includes("x-ai/grok-4.5:batch"));
  assert.ok(v.includes("x-ai/grok-4.5"));
});
