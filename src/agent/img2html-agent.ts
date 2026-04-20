import { initChatModel } from "langchain";
import { createAgent, tool, HumanMessage, BaseMessage, ToolMessage, AIMessage } from "langchain";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult, ChatGeneration } from "@langchain/core/outputs";
import { z } from "zod";
import type { VirtualFileSystem } from "@platformatic/vfs";
import { loadImageAsDataUrl, type ImageScalerOptions } from "../utils/image.js";
import {
  type TokenUsageAccumulator,
  createTokenAccumulator,
  addIterationTokens,
} from "../types/token-usage.js";

export type Stack = "html_css" | "tailwind";

export interface AgentResult {
  success: boolean;
  outputPath?: string;
  content?: string;
  iterations: number;
  tokenUsage: TokenUsageAccumulator | null;
  error?: string;
}

export interface Logger {
  log: (msg: string) => void;
  debug?: (msg: string) => void;
}

class AgentCallbackHandler extends BaseCallbackHandler {
  name = "agent_callback_handler";
  private logger: Logger;

  calls: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [];
  log: Array<{
    step: number;
    direction: "to_llm" | "from_llm";
    messages: BaseMessage[];
    timestamp: Date;
    runId?: string;
  }> = [];

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  async handleChatModelStart(
    _serialized: Record<string, any>,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string
  ) {
    const inputMessages = Array.isArray(messages) ? messages[0] ?? [] : [];
    this.log.push({
      step: this.log.length + 1,
      direction: "to_llm",
      messages: inputMessages,
      timestamp: new Date(),
      runId
    });
  }

  async handleLLMEnd(output: LLMResult) {
    const tokenUsage = output.llmOutput?.tokenUsage;
    if (tokenUsage) {
      const promptTokens = tokenUsage.promptTokens ?? 0;
      const completionTokens = tokenUsage.completionTokens ?? 0;
      const totalTokens = tokenUsage.totalTokens ?? (promptTokens + completionTokens);
      this.calls.push({ promptTokens, completionTokens, totalTokens });
      this.logger.log(`\n[API Call #${this.calls.length}] Prompt: ${promptTokens}, Completion: ${completionTokens}, Total: ${totalTokens}`);
    }

    const aiResponses: BaseMessage[] = [];
    for (const genList of output.generations) {
      for (const gen of genList) {
        const chatGen = gen as ChatGeneration;
        if (chatGen.message) aiResponses.push(chatGen.message);
      }
    }
    if (aiResponses.length > 0) {
      this.log.push({
        step: this.log.length + 1,
        direction: "from_llm",
        messages: aiResponses,
        timestamp: new Date()
      });
    }
  }

  async handleToolEnd(output: any) {
    if (output.toolOutput) {
      try {
        const toolMsg = new ToolMessage({
          content: typeof output.toolOutput === 'string' ? output.toolOutput : JSON.stringify(output.toolOutput),
          tool_call_id: output.toolCall?.id || output.tool_call_id || "",
          name: output.tool?.name || output.toolName || "unknown",
        });
        this.log.push({
          step: this.log.length + 1,
          direction: "from_llm",
          messages: [toolMsg],
          timestamp: new Date()
        });
      } catch {
      }
    }
  }

  getLogEntries(): Array<{ messages: BaseMessage[]; timestamp: Date }> {
    return this.log;
  }

  reset() {
    this.calls = [];
    this.log = [];
  }
}

function serializeMessages(entries: Array<{ messages: BaseMessage[]; timestamp: Date }>): object[] {
  return entries.flatMap(entry =>
    entry.messages.map(msg => {
      const base: Record<string, unknown> = {
        type: msg._getType(),
        timestamp: entry.timestamp.toISOString(),
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
    })
  );
}

function extractTextContent(chunk: any): string | null {
  if (typeof chunk.content === "string") return chunk.content;
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  if (typeof chunk.text === "string") return chunk.text;
  return null;
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

export interface RunAgentOptions {
  imagePath: string;
  stack: Stack;
  modelString: string;
  additionalPrompt?: string;
  imageScalerOptions?: ImageScalerOptions;
  logFile?: string;
}

export async function runAgent(
  options: RunAgentOptions,
  vfs: VirtualFileSystem,
  logger: Logger
): Promise<AgentResult> {
  const { imagePath, stack, modelString, additionalPrompt, imageScalerOptions, logFile } = options;

  logger.log(`\n${"=".repeat(60)}`);
  logger.log(`Stack: ${stack} | Model: ${modelString}`);
  logger.log(`${"=".repeat(60)}\n`);

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

function normalizeVfsPath(filePath: string): string {
  return filePath.startsWith('/') ? filePath : `/${filePath}`;
}

const createFileTool = tool(
    async ({ path: filePath, content }: { path: string; content: string }) => {
      const normalizedPath = normalizeVfsPath(filePath);
      logger.debug?.(`[createFile] path="${normalizedPath}" contentLength=${content.length}`);

      const isUnderOutputDir = vfs.shouldHandle(normalizedPath);
      if (!isUnderOutputDir) {
        const error = `Security: Path "${normalizedPath}" escapes output directory`;
        logger.debug?.(`[createFile] ${error}`);
        throw new Error(error);
      }

      const dir = normalizedPath.split('/').slice(0, -1).join('/') || '/';
      if (!vfs.existsSync(dir)) {
        logger.debug?.(`[createFile] creating directory "${dir}"`);
        vfs.mkdirSync(dir, { recursive: true });
      }

      logger.debug?.(`[createFile] writing ${content.length} bytes to "${normalizedPath}"`);
      vfs.writeFileSync(normalizedPath, content, "utf-8");
      fileState.current = { path: normalizedPath, content };

      const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
      logger.debug?.(`[createFile] success, contentLength=${content.length}`);

      return JSON.stringify({
        success: true,
        path: normalizedPath,
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
      const normalizedPath = normalizeVfsPath(filePath);
      logger.debug?.(`[editFile] path="${normalizedPath}" old_textLength=${old_text.length} new_textLength=${new_text.length} count=${count}`);

      if (!fileState.current) {
        const error = "No file has been created yet. Use create_file first.";
        logger.debug?.(`[editFile] ${error}`);
        return JSON.stringify({
          success: false,
          error,
        });
      }

      const isUnderOutputDir = vfs.shouldHandle(normalizedPath);
      if (!isUnderOutputDir) {
        const error = `Security: Path "${normalizedPath}" escapes output directory`;
        logger.debug?.(`[editFile] ${error}`);
        throw new Error(error);
      }

      let content = fileState.current.content;

      if (!content.includes(old_text)) {
        const error = "Could not find old_text in the file";
        logger.debug?.(`[editFile] ${error}`);
        return JSON.stringify({
          success: false,
          error,
          old_text_preview: old_text.slice(0, 100),
        });
      }

      const replaceCount = count ?? 1;
      let newContent: string;
      if (replaceCount === -1) {
        newContent = content.split(old_text).join(new_text);
      } else {
        let occurrences = 0;
        newContent = content.split(old_text).reduce((acc, part, idx, arr) => {
          if (idx < arr.length - 1 && occurrences < replaceCount) {
            occurrences++;
            return acc + part + new_text;
          }
          return acc + part;
        }, "");
      }

      logger.debug?.(`[editFile] writing ${newContent.length} bytes to "${normalizedPath}"`);
      vfs.writeFileSync(normalizedPath, newContent, "utf-8");
      fileState.current = { path: normalizedPath, content: newContent };

      logger.debug?.(`[editFile] success, replaced ${replaceCount} occurrence(s)`);

      return JSON.stringify({
        success: true,
        path: normalizedPath,
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

  const callbackHandler = new AgentCallbackHandler(logger);
  let toolCallCount = 0;

  const userMessage = new HumanMessage({
    contentBlocks: [
      { type: "image", url: imageDataUrl },
      { type: "text", text: buildUserPrompt(stack, additionalPrompt) },
    ],
  });

  const tokenAccumulator = createTokenAccumulator();

  try {
    let streamResult;
    try {
      streamResult = await agent.stream(
        { messages: [userMessage] },
        { callbacks: [callbackHandler] }
      );
    } catch (streamError) {
      return {
        success: false,
        iterations: toolCallCount,
        tokenUsage: tokenAccumulator,
        error: `Stream error: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
      };
    }

    try {
      for await (const chunk of streamResult) {
        if (typeof chunk === "string") {
          process.stdout.write(chunk);
        } else if (chunk) {
          const chunkData = chunk as any;
          const text = extractTextContent(chunkData);
          if (text) {
            process.stdout.write(text);
          }

          if (chunkData.tool_calls && chunkData.tool_calls.length > 0) {
            toolCallCount++;
            logger.log(`[Tool calls detected]`);
          }
        }
      }
    } catch (iterationError) {
      const errorMessage = iterationError instanceof Error ? iterationError.message : String(iterationError);
      return {
        success: false,
        iterations: toolCallCount,
        tokenUsage: tokenAccumulator,
        error: `Iteration error: ${errorMessage}`,
      };
    }

    const totalPromptTokens = callbackHandler.calls.reduce((sum, c) => sum + c.promptTokens, 0);
    const totalCompletionTokens = callbackHandler.calls.reduce((sum, c) => sum + c.completionTokens, 0);
    const totalTokensAll = callbackHandler.calls.reduce((sum, c) => sum + c.totalTokens, 0);
    logger.log("\n\nStream completed");
    logger.log(`Total API calls: ${callbackHandler.calls.length}`);
    logger.log(`Total tool calls: ${toolCallCount}`);
    logger.log(`Total tokens - Prompt: ${totalPromptTokens}, Completion: ${totalCompletionTokens}, Combined: ${totalTokensAll}`);

    for (let i = 0; i < callbackHandler.calls.length; i++) {
      const call = callbackHandler.calls[i];
      addIterationTokens(tokenAccumulator, i + 1, call.promptTokens, call.completionTokens, 1);
    }
    tokenAccumulator.totals.apiCalls = callbackHandler.calls.length;

    if (logFile) {
      const logEntries = callbackHandler.getLogEntries();
      const logData = {
        timestamp: new Date().toISOString(),
        messageCount: logEntries.reduce((sum, e) => sum + e.messages.length, 0),
        messages: serializeMessages(logEntries),
      };
      try {
        vfs.writeFileSync(logFile, JSON.stringify(logData, null, 2), "utf-8");
      } catch (error) {
        logger.log(`Warning: Failed to write log file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (fileState.current) {
      const outPath = fileState.current.path;

      logger.log(`\n${"=".repeat(60)}`);
      logger.log(`Output written to: ${outPath}`);
      logger.log(`${"=".repeat(60)}\n`);

      return {
        success: true,
        outputPath: outPath,
        content: fileState.current.content,
        iterations: toolCallCount,
        tokenUsage: tokenAccumulator,
      };
    }

    return {
      success: false,
      iterations: toolCallCount,
      tokenUsage: tokenAccumulator,
      error: "Agent completed without producing output file",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.log(`Agent error: ${errorMessage}`);
    if (errorStack) {
      logger.log(`Stack: ${errorStack}`);
    }
    return {
      success: false,
      iterations: toolCallCount,
      tokenUsage: tokenAccumulator,
      error: errorMessage,
    };
  }
}

export function serializeLogMessages(entries: Array<{ messages: BaseMessage[]; timestamp: Date }>): object[] {
  return serializeMessages(entries);
}

export { loadImageAsDataUrl };
