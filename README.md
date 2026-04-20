# img2html

AI-powered CLI tool that converts images and screenshots to HTML+CSS using LangChain agents.

## Features

- Converts images to responsive HTML+CSS code
- Supports multiple frontend stacks: plain HTML/CSS or Tailwind CSS
- Works with multiple LLM providers: OpenAI, Anthropic, OpenRouter, Google Gemini, MiniMax
- Generates multiple variants for comparison
- Stores generation metadata (tokens, params, conversation logs)
- Can be used as a library in other Node.js applications

## Installation

```bash
npm install
npm run build
```

## Usage

### CLI

```bash
img2html <image-path-or-url> [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-s, --stack <stack>` | Frontend stack: "html_css" or "tailwind" (default: tailwind) |
| `-m, --model <model>` | Model to use (e.g., "openrouter:qwen/qwen3.5-9b") |
| `-v, --variants <number>` | Number of variants to generate (default: 1) |
| `-o, --output <dir>` | Output directory |
| `-p, --prompt <text>` | Additional instructions for the agent |
| `--max-width <pixels>` | Scale image max width |
| `--max-height <pixels>` | Scale image max height |
| `-t, --temperature <number>` | Model temperature 0-1 (default: 0) |

**Examples:**

```bash
# Basic usage with OpenRouter
img2html screenshot.png --model openrouter:qwen/qwen3.5-9b

# With Tailwind, custom dimensions, and variants
img2html screenshot.png -s tailwind -m openrouter:anthropic/claude-3.5-sonnet --max-height 800 -v 3

# Using Anthropic
img2html screenshot.png --model anthropic:claude-sonnet-4-6

# Using Google Gemini
img2html screenshot.png --model gemini:gemini-2.0-flash
```

### Library Usage

```typescript
import { createAgentRunnerWithFile, createDefaultVfs } from 'img2html';

const vfs = createDefaultVfs('./output');
const logger = { log: (msg) => console.log(msg) };

const runner = createAgentRunnerWithFile(
  './screenshot.png',
  {
    stack: 'tailwind',
    modelConfig: {
      provider: 'openrouter',
      modelName: 'qwen/qwen3.5-9b',
      apiKey: process.env.OPENROUTER_API_KEY!,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/img2html',
        'X-Title': 'img2html',
      },
    },
    logFile: '/_meta/conversation.json',
    storeImageAs: '/_meta/input-image.png',
    genParamsFile: '/_meta/gen-params.json',
  },
  vfs,
  logger
);

const result = await runner.run();
console.log(result.outputPath);
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Required for OpenRouter models |
| `OPENROUTER_BASE_URL` | Optional, defaults to OpenRouter API |
| `ANTHROPIC_API_KEY` | Required for Anthropic models |
| `GOOGLE_API_KEY` | Required for Google Gemini models |
| `MINIMAX_API_KEY` | Required for MiniMax models |
| `IMG2HTML_STACK` | Default stack |
| `IMG2HTML_MODEL` | Default model |
| `IMG2HTML_VARIANTS` | Default variant count |
| `IMG2HTML_OUTPUT` | Default output directory |

## Output Structure

```
output-dir/
├── index.html           # Generated HTML
└── _meta/
    ├── input-image.png  # Resized input image
    ├── conversation.json # Full conversation log
    ├── gen-params.json  # Generation parameters
    └── tokens.json      # Token usage summary
```

## License

MIT
