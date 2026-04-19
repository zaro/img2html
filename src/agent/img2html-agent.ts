import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createCreateFileTool, createEditFileTool, type FileState } from "../tools/file-tools.js";
import { loadImageAsDataUrl, type ImageScalerOptions } from "../utils/image.js";
import { ensureDir } from "../utils/output.js";
import { SystemMessage, HumanMessage, AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { type BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type StructuredTool } from "@langchain/core/tools";
import * as path from "path";
import * as fs from "fs";

const MAX_ITERATIONS = 20;

export type Stack = "html_css" | "tailwind";

export interface AgentResult {
  success: boolean;
  outputPath?: string;
  content?: string;
  iterations: number;
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

async function initializeModel(modelString: string): Promise<BaseChatModel> {
  const [provider, modelName] = modelString.split(":");

  if (provider === "openai") {
    return new ChatOpenAI({ model: modelName || "gpt-4o", temperature: 0 });
  } else if (provider === "anthropic") {
    return new ChatAnthropic({ model: modelName || "claude-sonnet-4-6" });
  } else if (provider === "openrouter") {
    return new ChatOpenAI({
      model: modelName || "anthropic/claude-3.5-sonnet",
      apiKey: process.env.OPENROUTER_API_KEY,
      configuration: {
        baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://github.com/img2html",
          "X-Title": process.env.OPENROUTER_TITLE || "img2html CLI",
        },
      },
      temperature: 0,
    });
  } else if (provider === "gemini") {
    return new ChatGoogleGenerativeAI({
      model: modelName || "gemini-2.0-flash",
      apiKey: process.env.GOOGLE_API_KEY,
      temperature: 0,
    });
  } else if (provider === "minimax") {
    return new ChatOpenAI({
      model: modelName || "minimax:latest",
      apiKey: process.env.MINIMAX_API_KEY,
      configuration: {
        baseURL: process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1",
      },
      temperature: 0,
    });
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

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

  const fileState: { current: FileState | null } = { current: null };
  const createFileTool = createCreateFileTool(fileState, outputDir);
  const editFileTool = createEditFileTool(fileState, outputDir);
  const tools = [createFileTool, editFileTool];

  let model: BaseChatModel;
  let modelWithTools: any;

  try {
    model = await initializeModel(modelString);
    modelWithTools = (model as any).bindTools(tools);
  } catch (error) {
    return {
      success: false,
      iterations: 0,
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
      error: `Failed to load image: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const messages: BaseMessage[] = [
    new SystemMessage(getSystemPrompt(stack)),
  ];

  const userPromptContent: Array<{ type: "image_url"; image_url: { url: string; detail: string } } | { type: "text"; text: string }> = [
    { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } },
    { type: "text", text: buildUserPrompt(stack, additionalPrompt) }
  ];

  messages.push(new HumanMessage({ content: userPromptContent }));

  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      const response = await modelWithTools!.invoke(messages);

      const responseMsg = response as AIMessage;
      messages.push(responseMsg);

      if (typeof responseMsg.content === "string" && responseMsg.content.trim()) {
        process.stdout.write(responseMsg.content);
      }

      if (responseMsg.tool_calls && responseMsg.tool_calls.length > 0) {
        for (const tc of responseMsg.tool_calls) {
          iterations++;
          console.error(`\n[Tool: ${tc.name}]`);

          let toolResult: string;
          const args = tc.args as { path?: string; content?: string; old_text?: string; new_text?: string; count?: number | null };

          if (tc.name === "create_file" && args.path && args.content !== undefined) {
            toolResult = await createFileTool.invoke({ path: args.path, content: args.content });
          } else if (tc.name === "edit_file" && args.path && args.old_text && args.new_text !== undefined) {
            toolResult = await editFileTool.invoke({ path: args.path, old_text: args.old_text, new_text: args.new_text, count: args.count ?? null });
          } else {
            toolResult = `Invalid tool arguments for ${tc.name}`;
          }

          const toolMsg = new ToolMessage({
            content: toolResult,
            tool_call_id: tc.id || `call_${Date.now()}`,
            name: tc.name,
          });
          messages.push(toolMsg);
        }
      } else {
        if (fileState.current) {
          const outPath = fileState.current.path;

          if (logFile) {
            writeLogFile(logFile, messages);
          }

          console.error(`\n\n${"=".repeat(60)}`);
          console.error(`Output written to: ${outPath}`);
          console.error(`${"=".repeat(60)}\n`);

          return {
            success: true,
            outputPath: outPath,
            content: fileState.current.content,
            iterations,
          };
        }
        break;
      }
    }

    if (logFile) {
      writeLogFile(logFile, messages);
    }

    return {
      success: false,
      iterations,
      error: "Max iterations reached without producing final output",
    };
  } catch (error) {
    if (logFile) {
      writeLogFile(logFile, messages);
    }

    return {
      success: false,
      iterations,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { loadImageAsDataUrl };