import fs from "node:fs";
import type { VirtualFileSystem } from "@platformatic/vfs";
import type { AgentRunnerBaseOptions } from "./types/options.js";
import type { AgentResult, Logger, Stack } from "./agent/img2html-agent.js";
import type { TokenUsageAccumulator } from "./types/token-usage.js";
import { runAgent } from "./agent/img2html-agent.js";
import { getPricing, formatCost, formatTokenCount } from "./utils/pricing.js";
import { calculateCost } from "./types/token-usage.js";

export interface AgentRunner {
  run(): Promise<AgentResult>;
}

function defaultLogger(debug: boolean = false): Logger {
  return {
    log: (msg: string) => console.error(msg),
    debug: debug ? (msg: string) => console.log(msg) : undefined,
  };
}

async function scaleImageBuffer(buffer: Buffer, options: { maxWidth?: number; maxHeight?: number }): Promise<{ buffer: Buffer; width?: number; height?: number }> {
  const sharp = (await import("sharp")).default;
  const { maxWidth, maxHeight } = options;

  if (!maxWidth && !maxHeight) {
    const metadata = await sharp(buffer).metadata();
    return { buffer, width: metadata.width, height: metadata.height };
  }

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    return { buffer, width: metadata?.width, height: metadata?.height };
  }

  let targetWidth = maxWidth;
  let targetHeight = maxHeight;

  if (targetWidth && targetHeight) {
    const ratio = Math.min(targetWidth / metadata.width, targetHeight / metadata.height);
    if (ratio >= 1) return { buffer, width: metadata.width, height: metadata.height };
    targetWidth = Math.round(metadata.width * ratio);
    targetHeight = Math.round(metadata.height * ratio);
  } else if (targetWidth) {
    if (targetWidth >= metadata.width) return { buffer, width: metadata.width, height: metadata.height };
    targetHeight = Math.round(metadata.height * (targetWidth / metadata.width));
  } else if (targetHeight) {
    if (targetHeight >= metadata.height) return { buffer, width: metadata.width, height: metadata.height };
    targetWidth = Math.round(metadata.width * (targetHeight / metadata.height));
  }

  const resizedBuffer = await sharp(buffer).resize(targetWidth, targetHeight, { fit: "inside" }).toBuffer();
  const resizedMeta = await sharp(resizedBuffer).metadata();
  return { buffer: resizedBuffer, width: resizedMeta.width, height: resizedMeta.height };
}

function readLocalFile(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export async function loadImageBuffer(
  imagePath: string,
  logger: Logger,
  scalerOptions?: { maxWidth?: number; maxHeight?: number }
): Promise<{ buffer: Buffer; width?: number; height?: number } | null> {
  const isUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");

  try {
    let buffer: Buffer;

    if (isUrl) {
      const response = await fetch(imagePath);
      if (!response.ok) {
        logger.log(`Warning: Failed to fetch image from URL: ${response.statusText}`);
        return null;
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      buffer = readLocalFile(imagePath);
    }

    if (scalerOptions && (scalerOptions.maxWidth || scalerOptions.maxHeight)) {
      return await scaleImageBuffer(buffer, scalerOptions);
    }

    const sharp = (await import("sharp")).default;
    const metadata = await sharp(buffer).metadata();
    return { buffer, width: metadata.width, height: metadata.height };
  } catch (error) {
    logger.log(`Warning: Failed to load image: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function writeGenParams(
  vfs: VirtualFileSystem,
  logger: Logger,
  params: {
    imagePath: string;
    provider: string;
    model: string;
    stack: Stack;
    maxWidth?: number;
    maxHeight?: number;
    imageWidth?: number;
    imageHeight?: number;
    additionalPrompt?: string;
    timestamp: string;
    success: boolean;
    error?: string;
  },
  filename: string = "/gen-params.json"
): void {
  try {
    vfs.writeFileSync(filename, JSON.stringify(params, null, 2), "utf-8");
    logger.log(`Generation params written to: ${filename}`);
  } catch (error) {
    logger.log(`Warning: Failed to write gen-params.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeTokensJson(
  vfs: VirtualFileSystem,
  logger: Logger,
  tokenUsage: TokenUsageAccumulator,
  pricingInfo: {
    pricing: { promptPer1M: number | null; completionPer1M: number | null } | null;
    source: string;
  },
  modelKey: string,
  filename: string = "/tokens.json"
): void {
  try {
    const tokensJson = {
      timestamp: new Date().toISOString(),
      pricing: {
        promptPer1M: pricingInfo.pricing?.promptPer1M || null,
        completionPer1M: pricingInfo.pricing?.completionPer1M || null,
        currency: "USD",
        source: pricingInfo.source,
      },
      totals: tokenUsage.totals,
      iterations: tokenUsage.iterations,
      usageMetadata: tokenUsage.usageMetadata ?? [],
    };
    vfs.writeFileSync(filename, JSON.stringify(tokensJson, null, 2), "utf-8");
    logger.log(`Tokens file written to: ${filename}`);
  } catch (error) {
    logger.log(`Warning: Failed to write tokens.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function printTokenSummary(
  logger: Logger,
  tokenUsage: TokenUsageAccumulator,
  pricingInfo: {
    pricing: { promptPer1M: number | null; completionPer1M: number | null } | null;
    source: string;
  },
  modelKey: string
): void {
  const { totals } = tokenUsage;

  logger.log("\nTokens used:");
  logger.log(`  API calls:        ${totals.apiCalls}`);
  logger.log(`  Prompt tokens:     ${formatTokenCount(totals.promptTokens)}`);
  logger.log(`  Completion tokens: ${formatTokenCount(totals.completionTokens)}`);
  logger.log(`  Total tokens:      ${formatTokenCount(totals.totalTokens)}`);

  if (pricingInfo.pricing) {
    const cost = calculateCost(
      { iterations: tokenUsage.iterations, totals },
      pricingInfo.pricing.promptPer1M,
      pricingInfo.pricing.completionPer1M
    );
    logger.log(`  Estimated cost:    ${formatCost(cost)}`);
    logger.log(`\n  (Based on: ${modelKey} @ $${pricingInfo.pricing.promptPer1M}/1M prompt, $${pricingInfo.pricing.completionPer1M}/1M completion)`);
  } else {
    logger.log(`  Estimated cost:    ${formatCost(null)}`);
    logger.log(`\n  (Pricing not available for ${modelKey})`);
  }
}

function runAgentWithMeta(
  imageBuffer: Buffer,
  options: AgentRunnerBaseOptions,
  vfs: VirtualFileSystem,
  logger: Logger
): Promise<AgentResult> {
  const result = runAgent(
    {
      imageBuffer,
      stack: options.stack,
      modelConfig: options.modelConfig,
      additionalPrompt: options.additionalPrompt,
      logFile: options.logFile,
      storeImageAs: options.storeImageAs,
    },
    vfs,
    logger
  );
  return result;
}

async function writeMetaFiles(
  imagePath: string,
  options: AgentRunnerBaseOptions,
  vfs: VirtualFileSystem,
  logger: Logger,
  result: AgentResult,
  imageWidth?: number,
  imageHeight?: number
): Promise<void> {
  if (options.genParamsFile) {
    writeGenParams(vfs, logger, {
      imagePath,
      provider: options.modelConfig.provider,
      model: options.modelConfig.modelName,
      stack: options.stack,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      imageWidth,
      imageHeight,
      additionalPrompt: options.additionalPrompt,
      timestamp: new Date().toISOString(),
      success: result.success,
      error: result.error || undefined,
    }, options.genParamsFile);
  }

  if (result.tokenUsage) {
    const modelKey = `${options.modelConfig.provider}:${options.modelConfig.modelName}`;
    const pricingInfo = await getPricing(modelKey);
    writeTokensJson(vfs, logger, result.tokenUsage, pricingInfo, modelKey, "/_meta/tokens.json");
    printTokenSummary(logger, result.tokenUsage, pricingInfo, modelKey);
  }
}

function ensureMetaDir(options: AgentRunnerBaseOptions, vfs: VirtualFileSystem): void {
  if (options.storeImageAs || options.logFile || options.genParamsFile) {
    vfs.mkdirSync("/_meta", { recursive: true });
  }
}

export function createAgentRunner(
  imageBuffer: Buffer,
  options: AgentRunnerBaseOptions,
  vfs: VirtualFileSystem,
  logger: Logger = defaultLogger(true)
): AgentRunner {
  return {
    run: async (): Promise<AgentResult> => {
      ensureMetaDir(options, vfs);
      const result = await runAgentWithMeta(imageBuffer, options, vfs, logger);
      await writeMetaFiles("", options, vfs, logger, result);
      return result;
    },
  };
}

export function createAgentRunnerWithFile(
  imagePath: string,
  options: AgentRunnerBaseOptions,
  vfs: VirtualFileSystem,
  logger: Logger = defaultLogger(true)
): AgentRunner {
  return {
    run: async (): Promise<AgentResult> => {
      ensureMetaDir(options, vfs);

      const scalerOptions = options.maxWidth || options.maxHeight
        ? { maxWidth: options.maxWidth, maxHeight: options.maxHeight }
        : undefined;

      const imageResult = await loadImageBuffer(imagePath, logger, scalerOptions);
      if (!imageResult) {
        return {
          success: false,
          iterations: 0,
          tokenUsage: null,
          error: "Failed to load image buffer",
        };
      }

      const result = await runAgentWithMeta(imageResult.buffer, options, vfs, logger);
      await writeMetaFiles(imagePath, options, vfs, logger, result, imageResult.width, imageResult.height);
      return result;
    },
  };
}
