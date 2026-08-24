export type VioletReasoningEffort = "low" | "medium" | "high";

export interface VioletModelConfig {
  model: string;
  reasoning_effort: VioletReasoningEffort;
}

export function getVioletModelConfig(): VioletModelConfig {
  const model = process.env.VIOLET_MODEL?.trim() || "gpt-5.6-sol";
  const configuredEffort = process.env.VIOLET_REASONING_EFFORT?.trim().toLowerCase();
  const reasoningEffort: VioletReasoningEffort =
    configuredEffort === "low" ||
    configuredEffort === "medium" ||
    configuredEffort === "high"
      ? configuredEffort
      : "high";
  return { model, reasoning_effort: reasoningEffort };
}
