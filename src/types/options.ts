export type ModelProvider = "openai" | "anthropic" | "openrouter" | "google-genai" | "minimax" | "ollama";

export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  temperature?: number;
}

export interface AgentRunnerBaseOptions {
  stack: "html_css" | "tailwind";
  modelConfig: ModelConfig;
  additionalPrompt?: string;
  maxWidth?: number;
  maxHeight?: number;
  logFile?: string;
  storeImageAs?: string;
  genParamsFile?: string;
}

export interface AgentRunnerOptionsWithBuffer extends AgentRunnerBaseOptions {
  imageBuffer: Buffer;
}

export interface AgentRunnerOptionsWithFile extends AgentRunnerBaseOptions {
  imagePath: string;
}
