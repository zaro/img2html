#!/usr/bin/env node

import { Command } from "commander";
import { runAgent, type Stack } from "./agent/img2html-agent.js";
import * as path from "path";
import { fileURLToPath } from "url";

interface CliOptions {
  stack: Stack;
  model: string;
  variants: number;
  output: string;
  prompt?: string;
  maxWidth?: number;
  maxHeight?: number;
  logFile?: string;
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
    .option("-o, --output <dir>", "Output directory", process.env.IMG2HTML_OUTPUT || "./output")
    .option("-p, --prompt <text>", "Additional instructions for the agent")
    .option("--max-width <pixels>", "Maximum width to scale image to (maintains aspect ratio)", (val) => val ? parseInt(val, 10) : undefined)
    .option("--max-height <pixels>", "Maximum height to scale image to (maintains aspect ratio)", (val) => val ? parseInt(val, 10) : undefined)
    .option("--log-file <path>", "File path to write raw agent conversation to")
    .action(async (imagePath: string, options: Partial<CliOptions>) => {
      const { stack, model, variants, output, prompt, maxWidth, maxHeight, logFile } = options;

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

      const resolvedOutput = path.resolve(output || "./output");

      console.error("Configuration:");
      console.error(`  Image: ${imagePath}`);
      console.error(`  Stack: ${stack}`);
      console.error(`  Model: ${model}`);
      console.error(`  Variants: ${variants}`);
      console.error(`  Output: ${resolvedOutput}`);
      if (maxWidth) console.error(`  Max Width: ${maxWidth}`);
      if (maxHeight) console.error(`  Max Height: ${maxHeight}`);
      if (logFile) console.error(`  Log File: ${logFile}`);
      if (prompt) console.error(`  Additional prompt: ${prompt}`);
      console.error("");

      let successCount = 0;
      let failureCount = 0;

      for (let i = 1; i <= (variants || 1); i++) {
        let variantLogFile: string | undefined;
        if (logFile) {
          if (variants && variants > 1) {
            const baseName = logFile.replace(/\.json$/, "");
            variantLogFile = `${baseName}-${i}.json`;
          } else {
            variantLogFile = logFile.endsWith(".json") ? logFile : `${logFile}.json`;
          }
        }

        const result = await runAgent({
          imagePath,
          stack: (stack || "tailwind") as Stack,
          modelString: model || "openai:gpt-4o",
          outputDir: resolvedOutput,
          additionalPrompt: prompt,
          variantIndex: variants && variants > 1 ? i : undefined,
          imageScalerOptions: (maxWidth || maxHeight) ? { maxWidth, maxHeight } : undefined,
          logFile: variantLogFile,
        });

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