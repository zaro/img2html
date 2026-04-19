import { initChatModel } from "langchain";
import { createAgent, tool, HumanMessage, SystemMessage, AIMessage, BaseMessage, ToolMessage } from "langchain";
import { z } from "zod";
import { loadImageAsDataUrl, type ImageScalerOptions } from "../utils/image.js";
import { ensureDir } from "../utils/output.js";
import {
  type TokenUsage,
  type TokenUsageAccumulator,
  createTokenAccumulator,
  addIterationTokens,
} from "../types/token-usage.js";

const MAX_ITERATIONS = 20;

export type Stack = "html_css" | "tailwind";

export interface AgentResult {
  success: boolean;
  outputPath?: string;
  content?: string;
  iterations: number;
  tokenUsage: TokenUsageAccumulator | null;
  error?: string;
}

function serializeMessages(messages: BaseMessage[]): object[] {
  return messages.map((msg) => {
    const base: Record<string, unknown> = {
      type: msg._getType(),
    };

    if (msg.content) {
      base.content = msg.content;
    }

    if (msg.name) {
      base.name = msg.name;
    }

    if (msg.additional_kwargs) {
      base.additional_kwargs = msg.additional_kwargs;
    }

    if (msg.response_metadata) {
      base.response_metadata = msg.response_metadata;
    }

    if ("tool_calls" in msg && msg.tool_calls) {
      base.tool_calls = msg.tool_calls;
    }

    if (msg._getType() === "tool") {
      const toolMsg = msg as ToolMessage;
      base.tool_call_id = toolMsg.tool_call_id;
      base.name = toolMsg.name;
    }

    return base;
  });
}

function writeLogFile(logFile: string, messages: BaseMessage[]): void {
  try {
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logData = {
      timestamp: new Date().toISOString(),
      messageCount: messages.length,
      messages: serializeMessages(messages),
    };
    fs.writeFileSync(logFile, JSON.stringify(logData, null, 2), "utf-8");
  } catch (error) {
    console.error(`Warning: Failed to write log file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractTokenUsage(response: AIMessage): { promptTokens: number; completionTokens: number } {
  const usageMetadata = (response as any).usage_metadata;
  const responseMetadata = (response as any).response_metadata;

  if (usageMetadata) {
    return {
      promptTokens: usageMetadata.input_tokens || 0,
      completionTokens: usageMetadata.output_tokens || 0,
    };
  }

  if (responseMetadata?.token_usage) {
    const usage = responseMetadata.token_usage;
    return {
      promptTokens: usage.prompt_tokens || usage.input_tokens || 0,
      completionTokens: usage.completion_tokens || usage.output_tokens || 0,
    };
  }

  return { promptTokens: 0, completionTokens: 0 };
}

function getSystemPrompt(stack: Stack): string {
  const base = `You are a coding agent that's an expert at building front-ends.

# Tone and style

- Be extremely concise in your chat responses.
- Do not include code snippets in your messages. Use the file creation and editing tools for all code.
- At the end of the task, respond with a one or two sentence summary of what was built.
- Always respond to the user in the language that they used.

# Tooling instructions

- You have access to tools for file creation and file editing.
- The main file is a single HTML file. Use path "index.html" unless told otherwise.
- For a brand new app, call create_file exactly once with the full HTML.
- For updates, call edit_file using exact string replacements. Do NOT regenerate the entire file.
- Do not output raw HTML in chat. Any code changes must go through tools.

# Stack-specific instructions

`;

  if (stack === "html_css") {
    return base + `
## html_css

- Only use HTML, CSS and JS.
- Do not use Tailwind
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>
`;
  } else {
    return base + `
## Tailwind

- Use this script to include Tailwind: <script src="https://cdn.tailwindcss.com"></script>
- Font Awesome for icons: <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.3/css/all.min.css"></link>
`;
  }
}

function buildUserPrompt(stack: Stack, additionalPrompt?: string): string {
  const stackInstructions = stack === "html_css"
    ? "Generate code using plain HTML, CSS and JavaScript only. Do NOT use Tailwind CSS."
    : "Generate code using HTML with Tailwind CSS via CDN.";

  let prompt = `Generate code for a web page that looks exactly like the provided screenshot(s).

Selected stack: ${stack}

## Replication instructions

- Make sure the app looks exactly like the screenshot.
- Use the exact text from the screenshot.
- For images, use appropriate placeholder URLs or inline SVG.

${additionalPrompt ? `\n## Additional instructions\n\n${additionalPrompt}` : ""}

${stackInstructions}
`;

  return prompt;
}

async function initializeModel(modelString: string) {
  const config: Record<string, unknown> = {
    temperature: 0,
  };

  if (modelString.startsWith("openrouter:")) {
    const modelName = modelString.replace("openrouter:", "");
    config.apiKey = process.env.OPENROUTER_API_KEY;
    config.configuration = {
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://github.com/img2html",
        "X-Title": process.env.OPENROUTER_TITLE || "img2html CLI",
      },
    };
    return initChatModel(modelName, { ...config, modelProvider: "openai" });
  } else if (modelString.startsWith("gemini:")) {
    const modelName = modelString.replace("gemini:", "");
    config.apiKey = process.env.GOOGLE_API_KEY;
    return initChatModel(modelName, { ...config, modelProvider: "google-genai" });
  } else if (modelString.startsWith("minimax:")) {
    const modelName = modelString.replace("minimax:", "");
    config.apiKey = process.env.MINIMAX_API_KEY;
    config.configuration = {
      baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
    };
    return initChatModel(modelName, { ...config, modelProvider: "openai" });
  }

  return initChatModel(modelString, config);
}

import * as path from "path";
import * as fs from "fs";

export async function runAgent(options: {
  imagePath: string;
  stack: Stack;
  modelString: string;
  outputDir: string;
  additionalPrompt?: string;
  variantIndex?: number;
  imageScalerOptions?: ImageScalerOptions;
  logFile?: string;
}): Promise<AgentResult> {
  const { imagePath, stack, modelString, outputDir, additionalPrompt, variantIndex, imageScalerOptions, logFile } = options;

  console.error(`\n${"=".repeat(60)}`);
  console.error(`Generating variant ${variantIndex || 1}`);
  console.error(`Stack: ${stack} | Model: ${modelString}`);
  console.error(`${"=".repeat(60)}\n`);

  let model;
  try {
    model = await initializeModel(modelString);
  } catch (error) {
    return {
      success: false,
      iterations: 0,
      tokenUsage: null,
      error: `Failed to initialize model: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let imageDataUrl: string;
  try {
    imageDataUrl = await loadImageAsDataUrl(imagePath, imageScalerOptions);
  } catch (error) {
    return {
      success: false,
      iterations: 0,
      tokenUsage: null,
      error: `Failed to load image: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const fileState: { current: { path: string; content: string } | null } = { current: null };

  const createFileTool = tool(
    async ({ path: filePath, content }: { path: string; content: string }) => {
      const resolvedPath = path.resolve(outputDir, filePath);
      const resolvedOutputDir = path.resolve(outputDir);
      const isUnderOutputDir = resolvedPath.startsWith(resolvedOutputDir + path.sep) || resolvedPath === resolvedOutputDir;
      if (!isUnderOutputDir) {
        throw new Error(`Security: Path "${filePath}" escapes output directory`);
      }

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath, content, "utf-8");
      fileState.current = { path: resolvedPath, content };

      const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;

      return JSON.stringify({
        success: true,
        path: resolvedPath,
        contentLength: content.length,
        preview,
      });
    },
    {
      name: "create_file",
      description: "Create the main HTML file for the app. Use exactly once to write the full HTML.",
      schema: z.object({
        path: z.string().describe("Path for the main HTML file. Use index.html if unsure."),
        content: z.string().describe("Full HTML for the single-file app."),
      }),
    }
  );

  const editFileTool = tool(
    async ({ path: filePath, old_text, new_text, count }: { path: string; old_text: string; new_text: string; count: number | null }) => {
      if (!fileState.current) {
        return JSON.stringify({
          success: false,
          error: "No file has been created yet. Use create_file first.",
        });
      }

      const resolvedPath = path.resolve(outputDir, filePath);
      const resolvedOutputDir = path.resolve(outputDir);
      const isUnderOutputDir = resolvedPath.startsWith(resolvedOutputDir + path.sep) || resolvedPath === resolvedOutputDir;
      if (!isUnderOutputDir) {
        throw new Error(`Security: Path "${filePath}" escapes output directory`);
      }

      let content = fileState.current.content;

      if (!content.includes(old_text)) {
        return JSON.stringify({
          success: false,
          error: `Could not find old_text in the file. Make sure the exact string exists.`,
          old_text_preview: old_text.slice(0, 100),
        });
      }

      const replaceCount = count ?? 1;
      if (replaceCount === -1) {
        content = content.split(old_text).join(new_text);
      } else {
        let occurrences = 0;
        content = content.split(old_text).reduce((acc, part, idx, arr) => {
          if (idx < arr.length - 1 && occurrences < replaceCount) {
            occurrences++;
            return acc + part + new_text;
          }
          return acc + part;
        }, "");
      }

      fs.writeFileSync(resolvedPath, content, "utf-8");
      fileState.current = { path: resolvedPath, content };

      return JSON.stringify({
        success: true,
        path: resolvedPath,
        edit_summary: `Replaced ${count ?? 1} occurrence(s) of text (${old_text.length} chars) with (${new_text.length} chars)`,
      });
    },
    {
      name: "edit_file",
      description: "Edit the main HTML file using exact string replacements. Do not regenerate the entire file.",
      schema: z.object({
        path: z.string().describe("Path for the main HTML file."),
        old_text: z.string().describe("Exact text to replace. Must match the file contents."),
        new_text: z.string().describe("Replacement text."),
        count: z.number().int().nullable().describe("How many occurrences to replace. Defaults to 1."),
      }),
    }
  );

  const agent = createAgent({
    model,
    tools: [createFileTool, editFileTool],
    systemPrompt: getSystemPrompt(stack),
  });

  const userMessage = new HumanMessage({
    contentBlocks: [
      { type: "image", url: imageDataUrl },
      { type: "text", text: buildUserPrompt(stack, additionalPrompt) },
    ],
  });

  const tokenAccumulator = createTokenAccumulator();
  let iterations = 0;
  let apiCalls = 0;

  try {
    let isFirstChunk = true;
    const fullContent: string[] = [];

    const streamResult = await agent.stream({
      messages: [userMessage],
    });

    for await (const chunk of streamResult) {
      const chunkStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
      fullContent.push(chunkStr);

      if (isFirstChunk) {
        isFirstChunk = false;
      }

      if (chunk && typeof chunk === "object" && "tool_calls" in chunk) {
        iterations++;
        console.error(`\n[Tool calls detected in stream]`);
      }

      process.stdout.write(chunkStr);
    }

    console.error("\n\nStream completed");
    console.error(`Iterations: ${iterations}, API calls: ${apiCalls}`);

    if (fileState.current) {
      const outPath = fileState.current.path;

      console.error(`\n${"=".repeat(60)}`);
      console.error(`Output written to: ${outPath}`);
      console.error(`${"=".repeat(60)}\n`);

      return {
        success: true,
        outputPath: outPath,
        content: fileState.current.content,
        iterations,
        tokenUsage: tokenAccumulator,
      };
    }

    return {
      success: false,
      iterations,
      tokenUsage: tokenAccumulator,
      error: "Agent completed without producing output file",
    };
  } catch (error) {
    return {
      success: false,
      iterations,
      tokenUsage: tokenAccumulator,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { loadImageAsDataUrl };