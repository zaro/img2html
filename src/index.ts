#!/usr/bin/env node

import { Command } from "commander";
import { runAgent, type Stack } from "./agent/img2html-agent.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getPricing, formatCost, formatTokenCount } from "./utils/pricing.js";
import { calculateCost } from "./types/token-usage.js";

interface CliOptions {
  stack: Stack;
  model: string;
  variants: number;
  output: string;
  prompt?: string;
  maxWidth?: number;
  maxHeight?: number;
  logFile?: string;
  pricingFile?: string;
}

interface GenParams {
  imagePath: string;
  provider: string;
  model: string;
  stack: Stack;
  maxWidth?: number;
  maxHeight?: number;
  additionalPrompt?: string;
  timestamp: string;
}

function writeGenParams(outputDir: string, params: GenParams): void {
  try {
    const genParamsPath = path.join(outputDir, "gen-params.json");
    fs.writeFileSync(genParamsPath, JSON.stringify(params, null, 2), "utf-8");
    console.error(`Generation params written to: ${genParamsPath}`);
  } catch (error) {
    console.error(`Warning: Failed to write gen-params.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeTokensJson(
  outputDir: string,
  tokenUsage: { totals: { promptTokens: number; completionTokens: number; totalTokens: number; apiCalls: number }; iterations: Array<{ iteration: number; promptTokens: number; completionTokens: number; totalTokens: number; apiCalls: number }> },
  pricingInfo: { pricing: { promptPer1M: number | null; completionPer1M: number | null } | null; source: string }
): void {
  try {
    const tokensPath = path.join(outputDir, "tokens.json");
    const tokensJson = {
      timestamp: new Date().toISOString(),
      model: "",
      pricing: {
        promptPer1M: pricingInfo.pricing?.promptPer1M || null,
        completionPer1M: pricingInfo.pricing?.completionPer1M || null,
        currency: "USD",
        source: pricingInfo.source,
      },
      totals: tokenUsage.totals,
      iterations: tokenUsage.iterations,
    };
    fs.writeFileSync(tokensPath, JSON.stringify(tokensJson, null, 2), "utf-8");
    console.error(`Tokens file written to: ${tokensPath}`);
  } catch (error) {
    console.error(`Warning: Failed to write tokens.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printTokenSummary(
  tokenUsage: { totals: { promptTokens: number; completionTokens: number; totalTokens: number; apiCalls: number }; iterations: Array<{ iteration: number; promptTokens: number; completionTokens: number; totalTokens: number; apiCalls: number }> },
  pricingInfo: { pricing: { promptPer1M: number | null; completionPer1M: number | null } | null; source: string },
  modelKey: string
): void {
  const { totals } = tokenUsage;

  console.error("\nTokens used:");
  console.error(`  API calls:        ${totals.apiCalls}`);
  console.error(`  Prompt tokens:     ${formatTokenCount(totals.promptTokens)}`);
  console.error(`  Completion tokens: ${formatTokenCount(totals.completionTokens)}`);
  console.error(`  Total tokens:      ${formatTokenCount(totals.totalTokens)}`);

  if (pricingInfo.pricing) {
    const cost = calculateCost(
      { iterations: tokenUsage.iterations, totals },
      pricingInfo.pricing.promptPer1M,
      pricingInfo.pricing.completionPer1M
    );
    console.error(`  Estimated cost:    ${formatCost(cost)}`);
    console.error(`\n  (Based on: ${modelKey} @ $${pricingInfo.pricing.promptPer1M}/1M prompt, $${pricingInfo.pricing.completionPer1M}/1M completion)`);
  } else {
    console.error(`  Estimated cost:    ${formatCost(null)}`);
    console.error(`\n  (Pricing not available for ${modelKey})`);
  }
}

function generateDefaultOutputDir(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `out-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function copyImageToOutput(imagePath: string, outputDir: string): Promise<string | undefined> {
  try {
    const isUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
    const ext = path.extname(imagePath);
    const fileName = isUrl
      ? `input-image${ext}`
      : `input-image${ext}`;
    const destPath = path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    if (isUrl) {
      const response = await fetch(imagePath);
      if (!response.ok) {
        console.error(`Warning: Failed to fetch image from URL: ${response.statusText}`);
        return undefined;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(destPath, buffer);
    } else {
      fs.copyFileSync(imagePath, destPath);
    }

    console.error(`Original image copied to: ${destPath}`);
    return destPath;
  } catch (error) {
    console.error(`Warning: Failed to copy image: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function main() {
  const program = new Command();

  program
    .name("img2html")
    .description("Convert images/screenshots to HTML+CSS using AI agents")
    .version("1.0.0")
    .argument("<image-path-or-url>", "Path to image file or URL of the screenshot")
    .option("-s, --stack <stack>", 'Frontend stack: "html_css" or "tailwind"', process.env.IMG2HTML_STACK || "tailwind")
    .option("-m, --model <model>", 'Model to use (e.g., "openai:gpt-4o", "anthropic:claude-sonnet-4-6", "openrouter:anthropic/claude-3.5-sonnet", "gemini:gemini-2.0-flash", "minimax:minimax")', process.env.IMG2HTML_MODEL || "openai:gpt-4o")
    .option("-v, --variants <number>", "Number of variants to generate", (val) => parseInt(val, 10), parseInt(process.env.IMG2HTML_VARIANTS || "1", 10))
    .option("-o, --output <dir>", "Output directory")
    .option("-p, --prompt <text>", "Additional instructions for the agent")
    .option("--max-width <pixels>", "Maximum width to scale image to (maintains aspect ratio)", (val) => val ? parseInt(val, 10) : undefined)
    .option("--max-height <pixels>", "Maximum height to scale image to (maintains aspect ratio)", (val) => val ? parseInt(val, 10) : undefined)
    .option("--log-file [filename]", "Filename for agent conversation log (written to output dir)")
    .option("--pricing-file <path>", "Path to JSON file with provider pricing for non-OpenRouter models")
    .action(async (imagePath: string, options: Partial<CliOptions>) => {
      const { stack, model, variants, output, prompt, maxWidth, maxHeight, logFile, pricingFile } = options;

      if (!["html_css", "tailwind"].includes(stack || "")) {
        console.error('Error: Stack must be "html_css" or "tailwind"');
        process.exit(1);
      }

      if (variants && variants < 1) {
        console.error("Error: Variants must be at least 1");
        process.exit(1);
      }

      if ((maxWidth && maxWidth < 1) || (maxHeight && maxHeight < 1)) {
        console.error("Error: Max width and height must be positive integers");
        process.exit(1);
      }

      let resolvedOutput: string;
      let outputExplicit = false;

      if (output) {
        resolvedOutput = path.resolve(output);
        outputExplicit = true;
      } else if (process.env.IMG2HTML_OUTPUT) {
        resolvedOutput = path.resolve(process.env.IMG2HTML_OUTPUT);
        outputExplicit = true;
      } else {
        resolvedOutput = path.resolve(generateDefaultOutputDir());
        if (fs.existsSync(resolvedOutput)) {
          console.error(`Error: Output directory already exists: ${resolvedOutput}`);
          process.exit(1);
        }
      }

      console.error("Configuration:");
      console.error(`  Image: ${imagePath}`);
      console.error(`  Stack: ${stack}`);
      console.error(`  Model: ${model}`);
      console.error(`  Variants: ${variants}`);
      console.error(`  Output: ${resolvedOutput}${outputExplicit ? " (explicit)" : " (auto-generated)"}`);
      if (maxWidth) console.error(`  Max Width: ${maxWidth}`);
      if (maxHeight) console.error(`  Max Height: ${maxHeight}`);
      if (logFile !== undefined) console.error(`  Log File: ${logFile || "conversation.json"}`);
      if (prompt) console.error(`  Additional prompt: ${prompt}`);
      console.error("");

      let successCount = 0;
      let failureCount = 0;

      for (let i = 1; i <= (variants || 1); i++) {
        const variantOutputDir = variants && variants > 1
          ? path.join(resolvedOutput, `variant-${i}`)
          : resolvedOutput;

        let variantLogFile: string | undefined;
        if (logFile !== undefined) {
          const baseName = typeof logFile === "string" ? logFile : "conversation";
          const cleanName = baseName.replace(/\.json$/, "");
          if (variants && variants > 1) {
            variantLogFile = path.join(variantOutputDir, `${cleanName}-${i}.json`);
          } else {
            variantLogFile = path.join(variantOutputDir, `${cleanName}.json`);
          }
        }

        const result = await runAgent({
          imagePath,
          stack: (stack || "tailwind") as Stack,
          modelString: model || "openai:gpt-4o",
          outputDir: variantOutputDir,
          additionalPrompt: prompt,
          variantIndex: undefined,
          imageScalerOptions: (maxWidth || maxHeight) ? { maxWidth, maxHeight } : undefined,
          logFile: variantLogFile,
        });

        if (result.success) {
          successCount++;
          console.error(`\nVariant ${i} completed successfully in ${result.iterations} iterations`);

          const modelKey = model || "openai:gpt-4o";
          const [provider, modelName] = modelKey.split(":");

          await copyImageToOutput(imagePath, variantOutputDir);

          writeGenParams(variantOutputDir, {
            imagePath,
            provider,
            model: modelName,
            stack: (stack || "tailwind") as Stack,
            maxWidth,
            maxHeight,
            additionalPrompt: prompt,
            timestamp: new Date().toISOString(),
          });

          if (result.tokenUsage) {
            const pricingInfo = await getPricing(modelKey, pricingFile);
            writeTokensJson(variantOutputDir, result.tokenUsage, pricingInfo);
            printTokenSummary(result.tokenUsage, pricingInfo, modelKey);
          }
        } else {
          failureCount++;
          console.error(`\nVariant ${i} failed: ${result.error}`);
        }
      }

      console.error("\n" + "=".repeat(60));
      console.error(`Summary: ${successCount} succeeded, ${failureCount} failed`);
      console.error("=".repeat(60));

      if (failureCount > 0) {
        process.exit(1);
      }
    });

  program.parse();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});