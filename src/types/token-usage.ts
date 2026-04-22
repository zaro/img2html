export interface IterationTokens {
  iteration: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  apiCalls: number;
}

export interface TokenUsage {
  timestamp: string;
  model: string;
  pricing: {
    promptPer1M: number | null;
    completionPer1M: number | null;
    currency: string;
    source: "openrouter-api" | "config-file" | "unknown";
  };
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUSD: number | null;
    apiCalls: number;
  };
  iterations: IterationTokens[];
}

export interface TokenUsageAccumulator {
  iterations: IterationTokens[];
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    apiCalls: number;
  };
  usageMetadata?: Array<Record<string, any>>;
}

export function createTokenAccumulator(): TokenUsageAccumulator {
  return {
    iterations: [],
    totals: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      apiCalls: 0,
    },
    usageMetadata: [],
  };
}

export function addIterationTokens(
  accumulator: TokenUsageAccumulator,
  iteration: number,
  promptTokens: number,
  completionTokens: number,
  apiCalls: number = 1
): void {
  const totalTokens = promptTokens + completionTokens;
  accumulator.iterations.push({
    iteration,
    promptTokens,
    completionTokens,
    totalTokens,
    apiCalls,
  });
  accumulator.totals.promptTokens += promptTokens;
  accumulator.totals.completionTokens += completionTokens;
  accumulator.totals.totalTokens += totalTokens;
  accumulator.totals.apiCalls += apiCalls;
}

export function calculateCost(
  accumulator: TokenUsageAccumulator,
  promptPer1M: number | null,
  completionPer1M: number | null
): number | null {
  if (promptPer1M === null || completionPer1M === null) {
    return null;
  }
  const { totals } = accumulator;
  const promptCost = (totals.promptTokens / 1_000_000) * promptPer1M;
  const completionCost = (totals.completionTokens / 1_000_000) * completionPer1M;
  return promptCost + completionCost;
}
