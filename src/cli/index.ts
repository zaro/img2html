#!/usr/bin/env node

import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { createAgentRunnerWithFile } from "../factory.js";
import { createDefaultVfs } from "../impl/platformatic-vfs.js";
import type { Stack } from "../agent/img2html-agent.js";
import type { ModelConfig } from "../types/options.js";

function buildModelConfig(model: string | undefined): ModelConfig {
  if (!model) {
    throw new Error("No model configured. Use -m/--model option or set IMG2HTML_MODEL environment variable");
  }

  if (model.startsWith("openrouter:")) {
    const modelName = model.replace("openrouter:", "");
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY environment variable is not set");
    }
    return {
      provider: "openrouter",
      modelName,
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://github.com/img2html",
        "X-Title": process.env.OPENROUTER_TITLE || "img2html CLI",
      },
    };
  } else if (model.startsWith("anthropic:")) {
    const modelName = model.replace("anthropic:", "");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    return { provider: "anthropic", modelName, apiKey };
  } else if (model.startsWith("gemini:")) {
    const modelName = model.replace("gemini:", "");
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY environment variable is not set");
    }
    return { provider: "google-genai", modelName, apiKey };
  } else if (model.startsWith("minimax:")) {
    const modelName = model.replace("minimax:", "");
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      throw new Error("MINIMAX_API_KEY environment variable is not set");
    }
    return {
      provider: "minimax",
      modelName,
      apiKey,
      baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
    };
  }

  throw new Error(`Unsupported model prefix. Use 'openrouter:', 'anthropic:', 'gemini:', or 'minimax:'`);
}

interface CliOptions {
  stack: Stack;
  model: string;
  variants: number;
  output: string;
  prompt?: string;
  maxWidth?: number;
  maxHeight?: number;
  pricingFile?: string;
}

function generateDefaultOutputDir(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `out-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
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
    .option("--pricing-file <path>", "Path to JSON file with provider pricing for non-OpenRouter models")
    .action(async (imagePath: string, options: Partial<CliOptions>) => {
      const { stack, model, variants, output, prompt, maxWidth, maxHeight } = options;

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
      if (prompt) console.error(`  Additional prompt: ${prompt}`);
      console.error("");

      let successCount = 0;
      let failureCount = 0;

      for (let i = 1; i <= (variants || 1); i++) {
        const variantOutputDir = variants && variants > 1
          ? path.join(resolvedOutput, `variant-${i}`)
          : resolvedOutput;

        if (!fs.existsSync(variantOutputDir)) {
          fs.mkdirSync(variantOutputDir, { recursive: true });
        }

        const vfs = createDefaultVfs(variantOutputDir);
        const logger = {
          log: (msg: string) => console.error(msg),
        };

        const runner = createAgentRunnerWithFile(
          imagePath,
          {
            stack: (stack || "tailwind") as "html_css" | "tailwind",
            modelConfig: buildModelConfig(model),
            additionalPrompt: prompt,
            maxWidth,
            maxHeight,
            logFile: "/_meta/conversation.json",
            storeImageAs: "/_meta/input-image.png",
            genParamsFile: "/_meta/gen-params.json",
          },
          vfs,
          logger
        );

        const result = await runner.run();

        if (result.success) {
          successCount++;
          console.error(`\nVariant ${i} completed successfully in ${result.iterations} iterations`);
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
