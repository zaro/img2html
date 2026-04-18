import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { type BaseChatModel } from "@langchain/core/language_models/chat_models";

export type ModelProvider = "openai" | "anthropic" | "openrouter" | "gemini" | "minimax";

export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
}

export function parseModelString(modelString: string): ModelConfig {
  const [provider, modelName] = modelString.split(":") as [ModelProvider, string];

  if (!provider || !modelName) {
    throw new Error(`Invalid model string: ${modelString}. Expected format: provider:model (e.g., openai:gpt-4o)`);
  }

  if (!["openai", "anthropic", "openrouter", "gemini", "minimax"].includes(provider)) {
    throw new Error(`Unsupported provider: ${provider}. Supported: openai, anthropic, openrouter, gemini, minimax`);
  }

  return { provider, modelName };
}

export async function createModel(config: ModelConfig): Promise<BaseChatModel> {
  const { provider, modelName, apiKey } = config;

  switch (provider) {
    case "openai":
      return new ChatOpenAI({
        model: modelName,
        apiKey: apiKey || process.env.OPENAI_API_KEY,
        temperature: 0,
      });
    case "anthropic":
      return new ChatAnthropic({
        model: modelName,
        apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      });
    case "openrouter":
      return new ChatOpenAI({
        model: modelName,
        apiKey: apiKey || process.env.OPENROUTER_API_KEY,
        configuration: {
          baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://github.com/img2html",
            "X-Title": process.env.OPENROUTER_TITLE || "img2html CLI",
          },
        },
        temperature: 0,
      });
    case "gemini":
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: apiKey || process.env.GOOGLE_API_KEY,
        temperature: 0,
      });
    case "minimax":
      return new ChatOpenAI({
        model: modelName,
        apiKey: apiKey || process.env.MINIMAX_API_KEY,
        configuration: {
          baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
        },
        temperature: 0,
      });
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}