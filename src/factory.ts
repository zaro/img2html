import fs from "node:fs";
import type { VirtualFileSystem } from "@platformatic/vfs";
import type { Img2HtmlOptions } from "./types/options.js";
import type { AgentResult, Logger, Stack } from "./agent/img2html-agent.js";
import type { TokenUsageAccumulator } from "./types/token-usage.js";
import { runAgent } from "./agent/img2html-agent.js";
import { getPricing, formatCost, formatTokenCount } from "./utils/pricing.js";
import { calculateCost } from "./types/token-usage.js";

export interface AgentRunner {
  run(): Promise<AgentResult>;
}

export interface WriteOutputOptions {
  genParams?: string;
  tokens?: string;
  logFile?: string;
}

function defaultLogger(debug: boolean = false): Logger {
  return {
    log: (msg: string) => console.error(msg),
    debug: debug ? (msg: string) => console.log(msg) : undefined,
  };
}

async function scaleImageBuffer(buffer: Buffer, options: { maxWidth?: number; maxHeight?: number }): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const { maxWidth, maxHeight } = options;

  if (!maxWidth && !maxHeight) {
    return buffer;
  }

  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) {
    return buffer;
  }

  let targetWidth = maxWidth;
  let targetHeight = maxHeight;

  if (targetWidth && targetHeight) {
    const ratio = Math.min(targetWidth / metadata.width, targetHeight / metadata.height);
    if (ratio >= 1) return buffer;
    targetWidth = Math.round(metadata.width * ratio);
    targetHeight = Math.round(metadata.height * ratio);
  } else if (targetWidth) {
    if (targetWidth >= metadata.width) return buffer;
    targetHeight = Math.round(metadata.height * (targetWidth / metadata.width));
  } else if (targetHeight) {
    if (targetHeight >= metadata.height) return buffer;
    targetWidth = Math.round(metadata.width * (targetHeight / metadata.height));
  }

  return sharp(buffer).resize(targetWidth, targetHeight, { fit: "inside" }).toBuffer();
}

function readLocalFile(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export async function loadImageBuffer(
  imagePath: string,
  logger: Logger,
  scalerOptions?: { maxWidth?: number; maxHeight?: number }
): Promise<Buffer | null> {
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
      buffer = await scaleImageBuffer(buffer, scalerOptions);
    }

    return buffer;
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

export function createAgentRunner(
  options: Img2HtmlOptions,
  vfs: VirtualFileSystem,
  logger: Logger = defaultLogger(true)
): AgentRunner {
  return {
    run: async (): Promise<AgentResult> => {
      const scalerOptions = options.maxWidth || options.maxHeight
        ? { maxWidth: options.maxWidth, maxHeight: options.maxHeight }
        : undefined;

      const imageBuffer = await loadImageBuffer(options.imagePath, logger, scalerOptions);
      if (!imageBuffer) {
        return {
          success: false,
          iterations: 0,
          tokenUsage: null,
          error: "Failed to load image buffer",
        };
      }

      return runAgent(
        {
          imageBuffer,
          stack: options.stack,
          modelString: options.modelString,
          additionalPrompt: options.additionalPrompt,
          logFile: undefined,
        },
        vfs,
        logger
      );
    },
  };
}

export function createAgentRunnerWithOutput(
  options: Img2HtmlOptions,
  vfs: VirtualFileSystem,
  outputFiles: WriteOutputOptions,
  logger: Logger = defaultLogger(true)
): AgentRunner {
  return {
    run: async (): Promise<AgentResult> => {
      const scalerOptions = options.maxWidth || options.maxHeight
        ? { maxWidth: options.maxWidth, maxHeight: options.maxHeight }
        : undefined;

      const imageBuffer = await loadImageBuffer(options.imagePath, logger, scalerOptions);
      if (!imageBuffer) {
        return {
          success: false,
          iterations: 0,
          tokenUsage: null,
          error: "Failed to load image buffer",
        };
      }

      const result = await runAgent(
        {
          imageBuffer,
          stack: options.stack,
          modelString: options.modelString,
          additionalPrompt: options.additionalPrompt,
          logFile: outputFiles.logFile,
        },
        vfs,
        logger
      );

      const [provider, modelName] = options.modelString.split(":");

      if (outputFiles.genParams) {
        writeGenParams(vfs, logger, {
          imagePath: options.imagePath,
          provider,
          model: modelName,
          stack: options.stack,
          maxWidth: options.maxWidth,
          maxHeight: options.maxHeight,
          additionalPrompt: options.additionalPrompt,
          timestamp: new Date().toISOString(),
          success: result.success,
          error: result.error || undefined,
        }, outputFiles.genParams);
      }

      if (outputFiles.tokens && result.tokenUsage) {
        const pricingInfo = await getPricing(options.modelString);
        writeTokensJson(vfs, logger, result.tokenUsage, pricingInfo, options.modelString, outputFiles.tokens);
        printTokenSummary(logger, result.tokenUsage, pricingInfo, options.modelString);
      }

      return result;
    },
  };
}
