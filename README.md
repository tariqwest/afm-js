# fm-server

OpenAI-compatible HTTP server for Apple Foundation Models on macOS. Drop it into any Node.js app or point an OpenAI client at `http://*********:<port>/v1` to run inference on-device or via Private Cloud Compute.

## Overview

fm-server exposes a small, OpenAI-shaped HTTP surface over Apple's Foundation Models:

- **`system`** — On-device `SystemLanguageModel` via [`apple-fm-sdk`](https://github.com/tariqwest/ts-apple-fm-sdk) (in-process FFI)
- **`pcc`** — Private Cloud Compute `PrivateCloudComputeLanguageModel` via [`fm-wrap`](https://github.com/tariqwest/fm-wrap) (wraps the macOS `fm` CLI)

**Endpoints**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness check (no auth) |
| `GET` | `/v1/models` | List available models and supported parameters |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |

**Capabilities**

- Bearer-token auth on all routes except `/health`
- Server-sent events streaming (`stream: true`)
- Tool calling with optional stdio MCP server injection
- Structured output via `response_format` (`json_object`, `json_schema`)
- Per-request session lifecycle with automatic cleanup

## Models

| Model ID | Backend | Requirements |
|----------|---------|--------------|
| `system` | On-device `SystemLanguageModel` | macOS 26+, Apple Silicon, Apple Intelligence enabled |
| `pcc` | Private Cloud Compute via `fm` CLI | macOS 27+, `fm` CLI at `/usr/bin/fm` |

Requests with any other model ID are rejected with `400`.

## Requirements

- macOS 26 (Tahoe) or later (macOS 27+ for PCC)
- Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
- Node.js 20+
- For local development: sibling checkouts of [`ts-apple-fm-sdk`](https://github.com/tariqwest/ts-apple-fm-sdk) and [`fm-wrap`](https://github.com/tariqwest/fm-wrap)

## Install

```bash
npm install fm-server
# or
pnpm add fm-server
```

From source:

```bash
git clone https://github.com/tariqwest/fm-server.git
git clone https://github.com/tariqwest/ts-apple-fm-sdk.git ../ts-apple-fm-sdk
git clone https://github.com/tariqwest/fm-wrap.git ../fm-wrap
cd fm-server
pnpm install && pnpm run build
```

Homebrew:

```bash
brew tap tariqwest/tap
brew install fm-server
```

## Quick start

Embed the server in a Node.js process:

```typescript
import { startServer } from "fm-server";

const server = await startServer({
  port: 11434,
  host: "127.0.0.1",
  token: "sk-apple-11434",
});

// Server is listening — point any OpenAI client here:
//   baseURL: http://127.0.0.1:11434/v1
//   apiKey:  sk-apple-11434

await server.stop();
```

Or mount the Hono app in your own HTTP stack:

```typescript
import { createApp, InferenceService } from "fm-server";

const inference = InferenceService.create();
const app = createApp({ inference, token: "sk-apple-11434" });

// app.fetch is a standard Request → Response handler
```

### Chat completion

```bash
curl -X POST http://*********:11434/v1/chat/completions \
  -H "Authorization: Bearer *************" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "messages": [{"role": "user", "content": "Say hi."}]
  }'
```

### Private Cloud Compute

```bash
curl -X POST http://*********:11434/v1/chat/completions \
  -H "Authorization: Bearer *************" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pcc",
    "messages": [{"role": "user", "content": "Explain quantum computing."}]
  }'
```

### Streaming

```bash
curl -N -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-11434" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to five."}]
  }'
```

### Structured output

```bash
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-11434" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "person",
        "schema": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "age": {"type": "integer"}
          },
          "required": ["name", "age"]
        }
      }
    },
    "messages": [{"role": "user", "content": "Alice, age 30"}]
  }'
```

## Configuration

`startServer` accepts:

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `11434` | Listen port |
| `host` | `127.0.0.1` | Bind address |
| `token` | `null` | Bearer token; omit or set `null` to disable auth |
| `mcpServers` | `[]` | Stdio MCP servers whose tools are injected when the client sends none |
| `debug` | no-op | Log callback |

> **Auth note:** `startServer` defaults `token` to `null` (auth off) so embedders opt in explicitly. The `fm-server serve` CLI defaults to `sk-apple-11434` (auth on) and honors the `FM_SERVER_TOKEN` env var.

MCP server spec:

```typescript
await startServer({
  port: 11434,
  token: "sk-apple-11434",
  mcpServers: [
    { command: "python3", args: ["/path/to/mcp_server.py"] },
  ],
});
```

When MCP tools are injected, detected tool calls are executed automatically and the model is re-prompted for a final answer.

## Supported request parameters

**Accepted:** `temperature`, `max_tokens`, `seed`, `stream`, `stream_options`, `tools`, `tool_choice`, `response_format`

**Rejected with 400:** `logprobs`, `n` (unless `1`), `stop`, `presence_penalty`, `frequency_penalty`, image content

## Architecture

```
HTTP client
  → Hono (app.ts)
       → ChatRequestValidator
       → ContextManager        # fold messages → (instructions, prompt)
       → Session.open(backend)
            ├─ onDevice:
            │    → InferenceService
            │         → apple-fm-sdk (in-process FFI)
            │              → SystemLanguageModel
            └─ privateCloudCompute:
                 → PccInferenceService
                      → fm-wrap → /usr/bin/fm CLI
                           → PrivateCloudComputeLanguageModel
```

The adapter layer in `src/server/sdk/` maps OpenAI parameters to `GenerationOptions`, SDK errors to `AfmError`, and streaming snapshots to SSE deltas (on-device path).

The PCC adapter in `src/server/pcc/` wraps `fm-wrap`'s `respond()` function, converting its output to the same `InferenceRespondResult`/`InferenceStreamEvent` shapes.

| Module | Role |
|--------|------|
| `ModelProvider` | Model lifecycle, availability, context size, token counting |
| `GenerationMapper` | OpenAI params → `GenerationOptions` |
| `SdkErrorMapper` | SDK errors → `AfmError` |
| `InferenceService` | On-device: open, respond, stream, shutdown |
| `PccInferenceService` | PCC: respond, stream (via fm-wrap) |

## Project layout

```
fm-server/
├── src/server/       HTTP routes, SDK adapter, PCC adapter, MCP, validators
│   ├── sdk/          On-device inference (apple-fm-sdk)
│   ├── pcc/          PCC inference (fm-wrap)
│   ├── session/      Backend-dispatching session wrapper
│   └── ...
├── test/             unit and e2e tests
└── scripts/release.js
```

## Development

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
```

E2E tests require native `apple-fm-sdk` bindings and are skipped automatically when unavailable.

## Public API

Exported from the package root:

```typescript
import {
  startServer,
  createApp,
  InferenceService,
  Session,
  AfmError,
  ModelAvailability,
  McpStdioClient,
} from "fm-server";
```

See `src/server/index.ts` for the full export list.

## Background service (Homebrew)

The Homebrew formula registers a launchd service that keeps the server running in your login session (required for Apple Intelligence access):

```bash
brew services start fm-server
brew services info fm-server
```

Logs: `/opt/homebrew/var/log/fm-server.log`

## License

MIT