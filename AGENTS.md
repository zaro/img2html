# img2html CLI Tool

AI-powered tool that converts images/screenshots to HTML+CSS using LangChain agents.

## Architecture

### Library vs CLI Structure

The tool is designed as both a CLI application and a reusable library.

**Core Components:**

- `src/agent/img2html-agent.ts` - Core agent with VFS and logger injection
- `src/factory.ts` - Factory functions for creating agent runners
- `src/impl/platformatic-vfs.ts` - VFS creation using `@platformatic/vfs`
- `src/types/options.ts` - TypeScript interfaces for options

**VFS Abstraction:**

All file operations go through a Virtual File System (`@platformatic/vfs`) abstraction layer. The `RealFSProvider` with `overlay: false` sandboxes file operations to the output directory.

### Interfaces

```typescript
// Model configuration
type ModelProvider = "openai" | "anthropic" | "openrouter" | "google-genai" | "minimax";

interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  temperature?: number;
}

// Base options for agent runners
interface AgentRunnerBaseOptions {
  stack: "html_css" | "tailwind";
  modelConfig: ModelConfig;
  additionalPrompt?: string;
  maxWidth?: number;
  maxHeight?: number;
  logFile?: string;
  storeImageAs?: string;
  genParamsFile?: string;
}

// Runner with buffer (no file loading)
interface AgentRunnerOptionsWithBuffer extends AgentRunnerBaseOptions {
  imageBuffer: Buffer;
}

// Runner with file path (loads buffer first)
interface AgentRunnerOptionsWithFile extends AgentRunnerBaseOptions {
  imagePath: string;
}
```

### Factory Functions

```typescript
// Takes image buffer directly - for library use
createAgentRunner(imageBuffer: Buffer, options: AgentRunnerBaseOptions, vfs: VirtualFileSystem, logger?: Logger): AgentRunner

// Takes image path - loads buffer then calls createAgentRunner
createAgentRunnerWithFile(imagePath: string, options: AgentRunnerBaseOptions, vfs: VirtualFileSystem, logger?: Logger): AgentRunner
```

Both functions:
- Create `/_meta/` directory if needed
- Store image at `storeImageAs` path (if provided)
- Write conversation log at `logFile` path (if provided)
- Write gen-params.json at `genParamsFile` path (if provided)
- Write tokens.json at `/_meta/tokens.json`

### The Agent (`runAgent`)

`runAgent` receives:
- `imageBuffer: Buffer` - already loaded and optionally scaled
- `options` with modelConfig, stack, and output file paths

It:
1. Writes image to VFS if `storeImageAs` is set
2. Initializes the model with config
3. Creates data URL from buffer and sends to LLM with screenshot
4. Handles `create_file` and `edit_file` tools
5. Writes conversation log if `logFile` is set

### Tools

**create_file:**
- Takes `path` and `content`
- Normalizes path to absolute (adds leading `/` if missing)
- Validates path is under output directory via `vfs.shouldHandle()`
- Creates parent directories recursively
- Updates `fileState.current`

**edit_file:**
- Takes `path`, `old_text`, `new_text`, `count`
- Same path validation
- Performs exact string replacement

### Model Configuration

The CLI parses model prefix and builds `ModelConfig`:

```typescript
function buildModelConfig(model: string | undefined, temperature?: number): ModelConfig {
  // openrouter:model-name -> OPENROUTER_API_KEY, baseURL, defaultHeaders
  // anthropic:model-name -> ANTHROPIC_API_KEY
  // gemini:model-name -> GOOGLE_API_KEY
  // minimax:model-name -> MINIMAX_API_KEY, baseURL
}
```

### Output Directory Structure

```
output-dir/
├── index.html           # Generated HTML
└── _meta/
    ├── input-image.png  # Resized input image
    ├── conversation.json # Full conversation log
    ├── gen-params.json  # Generation parameters
    └── tokens.json      # Token usage summary
```

### VFS Path Handling

- All VFS paths should use leading `/` (e.g., `/conversation.json`)
- `vfs.shouldHandle('/output/index.html')` returns `true`
- `vfs.shouldHandle('output/index.html')` returns `false` (relative paths fail validation)

## CLI Usage

```bash
img2html <image-path-or-url> [options]

Options:
  -s, --stack <stack>         Frontend stack: "html_css" or "tailwind" (default: tailwind)
  -m, --model <model>         Model (e.g., "openrouter:qwen/qwen3.5-9b")
  -v, --variants <number>     Number of variants to generate (default: 1)
  -o, --output <dir>          Output directory
  -p, --prompt <text>         Additional instructions
  --max-width <pixels>        Scale image max width
  --max-height <pixels>       Scale image max height
  -t, --temperature <number>  Model temperature (default: 0)
```

## Key Discoveries

- `createAgent` requires `modelProvider` explicitly set for OpenRouter/MiniMax (use `modelProvider: "openai"`)
- `AgentCallbackHandler` captures tokens via `handleLLMEnd` from `output.llmOutput.tokenUsage`
- OpenRouter API returns price **per token**, not per 1M tokens
- LangChain's `initChatModel` with OpenAI provider works for OpenRouter/MiniMax when configured with custom baseURL

## Environment Variables

```bash
OPENROUTER_API_KEY      # Required for openrouter: models
OPENROUTER_BASE_URL     # Optional, defaults to https://openrouter.ai/api/v1
OPENROUTER_REFERRER     # Optional
OPENROUTER_TITLE        # Optional
ANTHROPIC_API_KEY       # Required for anthropic: models
GOOGLE_API_KEY          # Required for gemini: models
MINIMAX_API_KEY         # Required for minimax: models
MINIMAX_BASE_URL        # Optional
IMG2HTML_STACK          # Default stack
IMG2HTML_MODEL          # Default model
IMG2HTML_VARIANTS       # Default variant count
IMG2HTML_OUTPUT         # Default output directory
```
