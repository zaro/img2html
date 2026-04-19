import * as fs from "fs";

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

interface PricingCache {
  [modelKey: string]: ModelPricing | null;
}

interface OpenRouterModelData {
  id: string;
  name: string;
  pricing?: {
    prompt?: number;
    completion?: number;
  };
}

let openRouterCache: PricingCache = {};
let configFileCache: Record<string, ModelPricing> | null = null;
let openRouterFetched = false;

export function loadPricingFromFile(filePath: string): Record<string, ModelPricing> {
  if (configFileCache) {
    return configFileCache;
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    configFileCache = {};

    for (const [key, value] of Object.entries(data)) {
      const pricing = value as { promptPer1M?: number; completionPer1M?: number };
      if (typeof pricing.promptPer1M === "number" && typeof pricing.completionPer1M === "number") {
        configFileCache[key] = {
          promptPer1M: pricing.promptPer1M,
          completionPer1M: pricing.completionPer1M,
        };
      }
    }

    return configFileCache;
  } catch (error) {
    console.error(`Warning: Failed to load pricing from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export async function fetchOpenRouterPricing(apiKey: string): Promise<PricingCache> {
  if (openRouterFetched) {
    return openRouterCache;
  }

  try {
    const baseURL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
    const response = await fetch(`${baseURL}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      console.error(`Warning: Failed to fetch OpenRouter pricing: ${response.statusText}`);
      openRouterFetched = true;
      return {};
    }

    const data = await response.json() as { data?: OpenRouterModelData[] };

    if (!data.data) {
      openRouterFetched = true;
      return {};
    }

    for (const model of data.data) {
      if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
        openRouterCache[model.id] = {
          promptPer1M: model.pricing.prompt,
          completionPer1M: model.pricing.completion,
        };
      }
    }

    openRouterFetched = true;
    return openRouterCache;
  } catch (error) {
    console.error(`Warning: Failed to fetch OpenRouter pricing: ${error instanceof Error ? error.message : String(error)}`);
    openRouterFetched = true;
    return {};
  }
}

export async function getPricing(
  modelKey: string,
  pricingFile?: string
): Promise<{ pricing: ModelPricing | null; source: "openrouter-api" | "config-file" | "unknown" }> {
  const [provider] = modelKey.split(":");

  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return { pricing: null, source: "unknown" };
    }
    const cache = await fetchOpenRouterPricing(apiKey);
    const modelName = modelKey.replace(/^openrouter:/, "");
    const pricing = cache[modelName] || null;
    if (!pricing && Object.keys(cache).length > 0) {
      console.error(`Warning: OpenRouter pricing fetched (${Object.keys(cache).length} models), but "${modelName}" not found in the list.`);
    }
    return { pricing, source: pricing ? "openrouter-api" : "unknown" };
  }

  if (pricingFile) {
    const config = loadPricingFromFile(pricingFile);
    const pricing = config[modelKey] || null;
    return { pricing, source: pricing ? "config-file" : "unknown" };
  }

  return { pricing: null, source: "unknown" };
}

export function formatCost(cost: number | null): string {
  if (cost === null) {
    return "unknown";
  }
  return `$${cost.toFixed(5)} USD`;
}

export function formatTokenCount(count: number): string {
  return count.toLocaleString();
}
