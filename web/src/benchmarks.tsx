import type { ReactNode } from "react";
import type { CatalogMeta } from "./types";

// Texts for the info icons. Source for the index composition: artificialanalysis.ai/methodology
// (checked September 2026, Intelligence Index v4.3). The API sends its own version number, which the tooltip shows.
const AA = "Source: Artificial Analysis (artificialanalysis.ai). The cockpit reads the index values from the OpenRouter model list (free, no key) and, with AA_API_KEY, from the Artificial Analysis API.";
const AA_SPEED = "Source: Artificial Analysis API. Needs AA_API_KEY in .env (free key).";

export function benchInfo(id: string, meta: CatalogMeta | null): ReactNode | null {
  const v = meta?.aaStatus?.version ? ` Version from the API: ${meta.aaStatus.version}.` : "";
  const noSpeedKey = meta && !meta.aaEnabled ? " Empty now: add AA_API_KEY to .env." : "";
  switch (id) {
    case "intelligence":
      return (
        <>
          <b>Artificial Analysis Intelligence Index</b> (0–100). One score from 10 evaluations, in four groups (v4.3):
          <br />• Agents 30%: AA-Briefcase, GDPval-AA, AutomationBench-AA
          <br />• Coding 20%: Terminal-Bench, SciCode
          <br />• General 30%: AA-Omniscience, GDP.pdf, AA-LCR (long context)
          <br />• Scientific reasoning 20%: Humanity's Last Exam, CritPt
          <br />
          {AA}
          {v}
        </>
      );
    case "coding":
      return (
        <>
          <b>Artificial Analysis Coding Index</b>. The coding part of the Intelligence Index (in v4.3: Terminal-Bench and SciCode). Higher is better. {AA}
        </>
      );
    case "agentic":
      return (
        <>
          <b>Artificial Analysis Agentic Index</b>. The agent part of the Intelligence Index (in v4.3: AA-Briefcase, GDPval-AA, AutomationBench-AA): multi-step work
          tasks with tools. Higher is better. {AA}
        </>
      );
    case "math":
      return (
        <>
          <b>Artificial Analysis Math Index</b>. The free API tier does not send it, so this column is usually empty. {AA}
        </>
      );
    case "gpqa":
      return (
        <>
          <b>GPQA Diamond</b>: graduate-level questions in biology, physics and chemistry. Share of correct answers. The free API tier does not send it, so this column is
          usually empty. {AA}
        </>
      );
    case "value":
      return (
        <>
          <b>Value</b> = Intelligence Index ÷ output price per 1M tokens (minimum $0.01). The cockpit calculates it. Higher means more intelligence per dollar.
        </>
      );
    case "speed":
      return (
        <>
          <b>Output speed</b>: median tokens per second after the first token, as measured by Artificial Analysis. {AA_SPEED}
          {noSpeedKey}
        </>
      );
    case "ttft":
      return (
        <>
          <b>Time to first token</b>: median seconds until the first token arrives, as measured by Artificial Analysis. {AA_SPEED}
          {noSpeedKey}
        </>
      );
    case "status":
      return (
        <>
          <b>Availability</b>. Free checks, no cost:
          <br />1. <b>Key model list</b> (OpenRouter /models/user, needs OPENROUTER_API_KEY): the models that your key may use. Turing College limits its keys
          with guardrails, so this is the real answer. "Not for your key" = the key cannot call it.
          <br />2. <b>Providers</b> (OpenRouter endpoints API): how many providers serve the model. Click the label to see each provider with uptime, prices and the
          provider slug. "Retired" = the OpenRouter page exists, but no provider serves it.
          <br />The small button makes one test call for this model (costs a fraction of a cent; the result shows for 3 seconds and stays in the tooltip).
          <br />Greyed-out rows do not work now.
        </>
      );
    default:
      return null;
  }
}
