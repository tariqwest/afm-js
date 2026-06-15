# AFM-JS

Apple Foundation Models in your local JS app, or anywhere an OpenAI-API is accepted. Access on-device (macOS 26+) and remote Private Cloud Compute (PCC) (macOS 27+) over IPC with either (a) the lightweight Swift helper that directly implements the `FoundationModels` API or (b) Apple's own implementation via their `fm` daemon/service built in to macOS.

### Features

* SDK `afm-js/core` + `swift` helpers for integrating Apple's `FoundationModels` into your JS/TS app or script
* CLI `afm-js/cli` for using Apple Intelligence on macOS from the terminal, or via bash or applescript
* SERVER `afm-js/server` for using Apple's local and PCC models in your IDE, agent, harness, or mcp server

### Models

- `system` aka `SystemLanguageModel`, via your Mac's GPU, 4096-token context, default. Requires macOS 26+.
- `pcc` aka `PrivateCloudComputeLanguageModel`, via your iCloud Account -> Apple Private Cloud Compute, 32K context. Requires macOS 27+.

Note: Using the PCC model uses the AI PCC quota included in the logged-in user's iCloud membership.

## Requirements

- macOS 26 (Tahoe) or later, Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
- Node 20+
- For PCC: macOS 27+

## Installation

#### Homebrew (Recommended)

```bash
# Add the tap
brew tap tariqwest/tap

# Install afm-js
brew install afm-js

# Start the server
afm-js serve --port 11434
```

#### From Source (Requires macOS 27 Xcode Beta)

```bash
# Clone the repository
git clone https://github.com/tariqwest/afm-js.git
cd afm-js

# Install dependencies and build
pnpm install
(cd helper && swift build -c release)
pnpm run build

# Run directly from source
node packages/afm-js/dist/main.js serve --port 11434
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  afm-js (Node 20+, TypeScript)                                      │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  @afm-js/server (Hono + Node)                                │   │
│  │  /v1/chat/completions  /v1/models  /health                   │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
│                             │                                       │
│                   UnifiedBackend (auto-selects)                     │
│                   FmSocketClient (per-request)                      │
│                   ┌─────────┴──────────┐                            │
│                   │                    │                            │
│                   ▼                    ▼                            │
│  ┌─────────────────────┐  ┌────────────────────────────┐            │
│  │  HelperProcessMgr   │  │  FmProcessManager          │            │
│  │  (backend A)        │  │  (backend B)               │            │
│  │                     │  │                            │            │
│  │  HTTP/1.1 over      │  │  HTTP/1.1 over             │            │
│  │  Unix socket        │  │  Unix socket               │            │
│  └──────────┬──────────┘  └──────────────┬─────────────┘            │
└─────────────┼────────────────────────────┼──────────────────────────┘
              ▼                            ▼
┌─────────────────────────┐   ┌─────────────────────────────────────┐
│  afm-fm-helper*         │   │  Apple fm daemon                    │
│  (Swift, macOS 26+)     │   │  (System, macOS 27+)                │
│                         │   │                                     │
│  serve --socket <path>  │   │  /usr/bin/fm serve --socket <path>  │
│                         │   │                                     │
│  FoundationModels API:  │   │  FoundationModels API:              │
│    SystemLanguageModel  │   │    SystemLanguageModel              │
│    LanguageModelSession │   │    PrivateCloudComputeLanguageModel │
│                         │   │    LanguageModelSession             │
│  ⚠ on-device only;      │   │                                     │
│    PCC requires Apple   │   │  ✓ supports PCC (system-signed)     │
│    dev entitlement      │   │                                     │
└─────────────────────────┘   └─────────────────────────────────────┘
```

`afm-fm-helper` implements the official, Apple-approved way to use `FoundationModels` in 3rd-party apps. It is spawned by the main server process and serves an OpenAI-compatible HTTP/1.1 API over a Unix domain socket, mirroring how Apple's own `fm` daemon and client work. Currently, the helper backend will not work with PCC as the binary needs to be signed by an Apple developer ID with a specific PCC entitlement. This will be updated once Apple approves the necessary entitlements for this author's developer id. In the meantime, if you have an apple developer account you can build and sign the helper binary yourself for use on your local machine.

## Layout

```
afm-js/
├── packages/
│   ├── core/        @afm-js/core    modeled after Apple's Python SDK
│   │   ├── src/sdk/                 LanguageModel, LanguageModelSession, AfmClient
│   │   ├── src/bridge/              HelperProcess, UnifiedBackend
│   │   └── examples/                SDK usage examples
│   ├── cli/         @afm-js/cli      argv -> typed config
│   ├── server/      @afm-js/server   Hono HTTP server + Session management
│   └── afm-js/      afm-js           CLI entry point, aggregates all packages
└── helper/                           Swift helper binary (afm-fm-helper)
    └── Sources/
        └── afm-fm-helper/           Swift FoundationModels bridge
```

## Build (dev)

```bash
# 1. Build the helper binary.
cd helper && swift build -c release

# 2. Install Node deps + typecheck.
cd .. && pnpm install && pnpm typecheck

# 3. Run the test suite.
pnpm test
```

## Run the server

**Homebrew installation:**
```bash
afm-js serve --port 11434 --token sk-test --debug
```

**From source:**
```bash
node packages/afm-js/bin/afm-js.js serve --port 11434 --token sk-test --debug
```

```bash
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{"model":"system","messages":[{"role":"user","content":"Say hi."}]}'
```

Streaming:

```bash
curl -N -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-test" -H "Content-Type: application/json" \
  -d '{"model":"system","stream":true,"messages":[{"role":"user","content":"Count to 5."}]}'
```

With a local MCP server (`--mcp` supports a colon-separated list of `<cmd> <arg…>` specs):

**Homebrew:**
```bash
afm-js serve --port 11434 --mcp "python3 /path/to/mcp/server.py"
```

**From source:**
```bash
node packages/afm-js/bin/afm-js.js serve --port 11434 --mcp "python3 /path/to/mcp/server.py"
```

## CLI Commands

The afm-js CLI mirrors Apple's `fm` client interface:

### respond 

Generate a one-shot response. Prompt can be a positional argument or piped via stdin.

```bash
afm-js respond "Your prompt here"
afm-js respond --model pcc "Use Private Cloud Compute"
afm-js respond --stream "Stream the response as it's generated"
afm-js respond --instructions "Be concise." "Explain recursion"
afm-js respond --json "Emit JSON envelope {model, content, finish_reason, usage}"
afm-js respond --temperature 0.8 --max-tokens 512 "Be creative"
afm-js respond --seed 42 "Reproducible output"
echo "What is 2+2?" | afm-js respond     # reads from stdin
```

Flags: `--model system|pcc` · `--stream` · `--instructions TEXT` · `--json` · `--temperature 0-1` · `--max-tokens N` · `--seed N` · `--helper PATH`

#### chat

Interactive multi-turn REPL. Always streams responses. Requires a TTY. Exit with Ctrl-D.

```bash
afm-js chat
afm-js chat --instructions "You are a coding assistant."
afm-js chat --model pcc
```

Flags: `--model system|pcc` · `--instructions TEXT` · `--helper PATH`

#### token-count

Count tokens without generating a response. Outputs total token count to stdout; use `--json` for a breakdown.

> **Note:** Implemented by running a minimal generation (`max_tokens=1`) and reading `promptTokens` from the response usage. The generated token is discarded.

```bash
afm-js token-count "This is a test prompt"
afm-js token-count --instructions "Be helpful" "Count these tokens"
afm-js token-count --json "Hello world"  # => {prompt_tokens, instructions_tokens, total_tokens}
```

Flags: `--instructions TEXT` · `--json` · `--helper PATH`

#### available

Check if Foundation Models are available on this device. Exits 0 if available, 1 if not (scriptable).

```bash
afm-js available
afm-js available --json   # => {available: true|false, status: "available"|...}
```

Status values: `available` · `appleIntelligenceNotEnabled` · `deviceNotEligible` · `modelNotReady`




#### quota-usage 

Check PCC quota usage. Requires the FM Client backend (`/usr/bin/fm` on macOS 27+). Prints a descriptive message when run against the helper backend. 
⚠ FM Client backend only

```bash
afm-js quota-usage
afm-js quota-usage --json  # => {used, limit, remaining}
```

#### schema

Generate a JSON schema for use with structured output. Runs locally — no model connection needed. Fields of the same type can be comma-separated.

```bash
afm-js schema object --name Person --string name --int age
afm-js schema object --name Product --string "name,sku" --number price --bool inStock
afm-js schema object --name Event --string title --string "location:where it happens" --json
```

Flags: `--name TEXT` · `--description TEXT` · `--string FIELD[,FIELD...]` · `--int FIELD[,FIELD...]` · `--number FIELD[,FIELD...]` · `--bool FIELD[,FIELD...]` · `--json`

#### serve

Start the OpenAI-compatible HTTP server.

```bash
afm-js serve
afm-js serve --port 11434 --host 0.0.0.0 --token sk-secret --debug
afm-js serve --mcp "python3 /path/to/mcp_server.py"  # attach stdio MCP server
afm-js serve --helper /path/to/afm-fm-helper           # override binary path
```

Flags: `--port N` (default 11434) · `--host ADDR` (default 127.0.0.1) · `--token SECRET` · `--debug` · `--mcp "CMD ARGS"` · `--helper PATH`

### Backend auto-selection

All commands auto-select the best available backend at startup:
- **FM Client** (`/usr/bin/fm`) — preferred when present (macOS 27+). Supports PCC.
- **afm-fm-helper** — fallback Swift binary. On-device only (PCC requires a pending Apple entitlement).

Force the helper with `--helper PATH` or `AFM_HELPER_PATH=...`. The `schema` command requires no backend.

### Structured outputs

```bash
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-test" -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "person",
        "schema": {
          "type": "object",
          "properties": {"name":{"type":"string"},"age":{"type":"integer"}},
          "required": ["name","age"]
        }
      }
    },
    "messages": [{"role":"user","content":"Give me a person named Alice who is 30."}]
  }'
# => {"name":"Alice","age":30}
```

## Homebrew Services (LaunchAgent)

When installed via Homebrew, afm-js can run as a background service that auto-starts at login:

```bash
# Start the service (starts now and at login)
brew services start afm-js

# Check service status
brew services info afm-js

# Restart the service
brew services restart afm-js

# Stop the service
brew services stop afm-js
```

The service runs on port 11434 by default. Logs are stored at:
- `/opt/homebrew/var/log/afm-js.log` (stdout)
- `/opt/homebrew/var/log/afm-js-error.log` (stderr)

This is run as a LaunchAgent because Apple Intelligence is only reachable from the logged-in user's GUI session.

## SDK Usage (@afm-js/core)

Use the SDK directly in your Node.js applications for programmatic access to Apple Foundation Models. This modeled after Apple's official [apple/python-apple-fm-sdk](https://github.com/apple/python-apple-fm-sdk).

### Simple Inference

```typescript
import * as fm from "@afm-js/core";

async function main() {
  // Get the default system foundation model
  const model = new fm.SystemLanguageModel();

  // Check if the model is available
  const [isAvailable, reason] = await model.isAvailable();
  if (!isAvailable) {
    console.log(`Foundation Models not available: ${reason}`);
    return;
  }

  // Create a session with instructions
  const session = new fm.LanguageModelSession({
    instructions: "You are a helpful assistant.",
  });

  // Generate a response
  const response = await session.respond("Hello, how are you?");
  console.log(`Assistant: ${response.content}`);
  console.log(`Usage: ${response.usage.promptTokens} prompt, ${response.usage.completionTokens} completion tokens`);

  // Cleanup
  await session.shutdown();
  await model.shutdown();
}
```

### Streaming Responses

```typescript
import * as fm from "@afm-js/core";

async function main() {
  const model = new fm.SystemLanguageModel();
  const [isAvailable] = await model.isAvailable();
  if (!isAvailable) return;

  const session = new fm.LanguageModelSession({
    instructions: "You are a helpful assistant.",
  });

  // Stream a response
  const prompt = "Tell me a short story about a cat.";
  process.stdout.write("Assistant: ");

  for await (const chunk of session.streamResponse(prompt)) {
    process.stdout.write(chunk.text);

    if (chunk.isFinal && chunk.usage) {
      console.log(`\n(Finish reason: ${chunk.finishReason}, ${chunk.usage.totalTokens} total tokens)`);
    }
  }

  await session.shutdown();
  await model.shutdown();
}
```

### SDK Examples

See for complete working examples:
- `simple_inference.ts` — Basic non-streaming inference
- `streaming_example.ts` — Streaming response handling
- `transcript_processing.ts` — Processing transcripts from Swift apps

Run examples:
```bash
cd packages/core
npx ts-node examples/simple_inference.ts
```

## Thanks & Inspiration

This ptoject was inspired by (but doesn't share code with) the following: 

- [Arthur-Ficial/apfel](https://github.com/Arthur-Ficial/apfel) - UNIX-style FoundationModels tool, forked to add PCC here [tariqwest/apfel-plus](https://github.com/tariqwest/apfel-plus).
- [codybrom/tsfm](https://github.com/codybrom/tsfm) — Koffi-FFI bindings for on-device FoundationModels; no PCC.
- [apple/python-apple-fm-sdk](https://github.com/apple/python-apple-fm-sdk) — Apple's official Python SDK.

## License

MIT.
