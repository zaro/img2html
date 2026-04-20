export interface AgentRunnerBaseOptions {
  stack: "html_css" | "tailwind";
  modelString: string;
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
