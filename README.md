# afm-server

OpenAI-compatible HTTP server for Apple Foundation Models on macOS. Drop it into any Node.js app or point an OpenAI client at `http://127.0.0.1:<port>/v1` to run inference on-device via [`apple-fm-sdk`](https://github.com/tariqwest/ts-apple-fm-sdk).

## Overview

afm-server exposes a small, OpenAI-shaped HTTP surface over Apple's on-device `SystemLanguageModel`. Inference runs in-process through `apple-fm-sdk` — no subprocess backends, no helper binaries, no IPC to `/usr/bin/fm`.

**Endpoints**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness check (no auth) |
| `GET` | `/v1/models` | List the on-device model and supported parameters |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |

**Capabilities**

- Bearer-token auth on all routes except `/health`
- Server-sent events streaming (`stream: true`)
- Tool calling with optional stdio MCP server injection
- Structured output via `response_format` (`json_object`, `json_schema`)
- Per-request `LanguageModelSession` lifecycle with automatic cleanup

## Model

Only one model is served:

| Model ID | Backend | Requirements |
|----------|---------|--------------|
| `system` | On-device `SystemLanguageModel` | macOS 26+, Apple Silicon, Apple Intelligence enabled |

Requests with `model: "pcc"` or any other model ID are rejected with `400`.

## Requirements

- macOS 26 (Tahoe) or later
- Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
- Node.js 20+
- For local development: a sibling checkout of [`ts-apple-fm-sdk`](https://github.com/tariqwest/ts-apple-fm-sdk)

## Install

```bash
npm install afm-server
# or
pnpm add afm-server
```

From source:

```bash
git clone https://github.com/tariqwest/afm-server.git
git clone https://github.com/tariqwest/ts-apple-fm-sdk.git ../ts-apple-fm-sdk
cd afm-server
pnpm install && pnpm run build
```

Homebrew:

```bash
brew tap tariqwest/tap
brew install afm-server
```

## Quick start

Embed the server in a Node.js process:

```typescript
import { startServer } from "afm-server";

const server = await startServer({
  port: 1337,
  host: "127.0.0.1",
  token: "sk-apple-1337",
});

// Server is listening — point any OpenAI client here:
//   baseURL: http://127.0.0.1:1337/v1
//   apiKey:  sk-apple-1337

await server.stop();
```

Or mount the Hono app in your own HTTP stack:

```typescript
import { createApp, InferenceService } from "afm-server";

const inference = InferenceService.create();
const app = createApp({ inference, token: "sk-apple-1337" });

// app.fetch is a standard Request → Response handler
```

### Chat completion

```bash
curl -X POST http://127.0.0.1:1337/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-1337" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "messages": [{"role": "user", "content": "Say hi."}]
  }'
```

### Streaming

```bash
curl -N -X POST http://127.0.0.1:1337/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-1337" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to five."}]
  }'
```

### Structured output

```bash
curl -X POST http://127.0.0.1:1337/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-1337" \
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

MCP server spec:

```typescript
await startServer({
  port: 1337,
  token: "sk-apple-1337",
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
       → Session               # per-request LanguageModelSession
            → InferenceService
                 → apple-fm-sdk (in-process FFI)
                      → SystemLanguageModel
                      → LanguageModelSession
```

The adapter layer in `src/server/sdk/` maps OpenAI parameters to `GenerationOptions`, SDK errors to `AfmError`, and streaming snapshots to SSE deltas.

| Module | Role |
|--------|------|
| `ModelProvider` | Model lifecycle, availability, context size, token counting |
| `GenerationMapper` | OpenAI params → `GenerationOptions` |
| `SdkErrorMapper` | SDK errors → `AfmError` |
| `InferenceService` | Open, respond, stream, shutdown |

## Project layout

```
afm-server/
├── src/server/       HTTP routes, SDK adapter, MCP, validators
├── test/             unit and e2e tests
├── examples/         standalone apple-fm-sdk demos
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
} from "afm-server";
```

See `src/server/index.ts` for the full export list.

## Using apple-fm-sdk directly

afm-server is the HTTP compatibility layer. For native FFI access without HTTP, use [`apple-fm-sdk`](https://github.com/tariqwest/ts-apple-fm-sdk) directly. Examples live in [`examples/`](examples/) and the [SDK repository](https://github.com/tariqwest/ts-apple-fm-sdk/tree/master/examples).

## Background service (Homebrew)

The Homebrew formula registers a launchd service that keeps the server running in your login session (required for Apple Intelligence access):

```bash
brew services start afm-server
brew services info afm-server
```

Logs: `/opt/homebrew/var/log/afm-server.log`

## License

MIT