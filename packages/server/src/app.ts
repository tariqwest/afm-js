// ============================================================================
// app.ts — Hono application factory. Registers the routes that mirror
// apfel-plus's Server.swift: /health, /v1/models, /v1/chat/completions.
// ============================================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  AfmError,
  ChatCompletionRequest,
  ChatRequestValidator,
  FinishReason,
  FinishReasonResolver,
  JSONFenceStripper,
  ModelBackend,
  ToolCallHandler,
  ToolResolution,
  UnifiedBackend,
  type OpenAITool,
} from "@afm-js/core";
import type { McpStdioClient } from "./mcp/McpClient.js";
import { makeContext } from "./session/ContextManager.js";
import { Session } from "./session/Session.js";

export interface AppConfig {
  /** Bearer token clients must present. Set to null/undefined to disable auth. */
  token?: string | null;
  /** Backend (fm CLI or helper) used to fulfill chat completion requests. */
  backend: UnifiedBackend;
  /** Optional set of MCP servers whose tools are injected when the client sent none. */
  mcpClients?: McpStdioClient[];
  /** Debug log function. */
  debug?: (msg: string) => void;
}

export function createApp(config: AppConfig): Hono {
  const app = new Hono();
  const debug = config.debug ?? (() => {});

  // MARK: - Bearer auth
  app.use("*", async (c, next) => {
    if (!config.token) {
      await next();
      return;
    }
    // /health doesn't require auth so health checks survive a misconfigured client.
    if (c.req.path === "/health") {
      await next();
      return;
    }
    const header = c.req.header("authorization") ?? "";
    if (header !== `Bearer ${config.token}`) {
      return c.json(
        {
          error: {
            message: "Missing or invalid bearer token.",
            type: "invalid_request_error",
          },
        },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    await next();
  });

  // MARK: - /health
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      model: "system",
      version: "0.0.1",
    });
  });

  // MARK: - /v1/models
  app.get("/v1/models", (c) => {
    const sharedParams = [
      "temperature",
      "max_tokens",
      "seed",
      "stream",
      "tools",
      "tool_choice",
      "response_format",
    ];
    const unsupported = ["logprobs", "n", "stop", "presence_penalty", "frequency_penalty"];
    return c.json({
      object: "list",
      data: [
        {
          id: "system",
          object: "model",
          created: 1719792000,
          owned_by: "apple",
          context_window: 4096,
          supported_parameters: sharedParams,
          unsupported_parameters: unsupported,
          notes:
            "Apple on-device model via FoundationModels framework. " +
            "Unsupported parameters are rejected with 400 when present (except n=1 and logprobs=false).",
        },
        // PCC entry advertised unconditionally; the helper returns the typed
        // pccUnavailable error at request time on ineligible hosts.
        {
          id: "pcc",
          object: "model",
          created: 1749340800,
          owned_by: "apple",
          context_window: 32_768,
          supported_parameters: sharedParams,
          unsupported_parameters: unsupported,
          notes:
            "Apple Private Cloud Compute via FoundationModels framework (macOS 27+). " +
            "32K context, no API keys. Opt in per request with " +
            'model: "pcc".'
        },
      ],
    });
  });

  // MARK: - POST /v1/chat/completions
  app.post("/v1/chat/completions", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
        400,
      );
    }

    const parsed = ChatCompletionRequest.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            message: `Request body validation failed: ${parsed.error.message}`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const request = parsed.data;

    const failure = ChatRequestValidator.validate(request);
    if (failure) {
      debug(ChatRequestValidator.event(failure));
      return c.json(
        {
          error: {
            message: ChatRequestValidator.message(failure),
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const backend = ModelBackend.fromModelName(request.model);

    // Inject MCP-discovered tools when the client sent none. The flag tells us
    // whether to auto-execute resulting tool calls (true only when MCP injected
    // them; client-supplied tools are returned to the client for execution).
    let mcpTools: OpenAITool[] = [];
    if (config.mcpClients && config.mcpClients.length > 0) {
      for (const m of config.mcpClients) {
        try {
          mcpTools.push(...(await m.listTools()));
        } catch (err) {
          debug(`mcp listTools failed (continuing): ${err}`);
        }
      }
    }
    const resolved = ToolResolution.resolve(request.tools ?? null, mcpTools);
    const effectiveTools = resolved.tools ?? undefined;

    // Multi-turn: ContextManager folds system + history + final turn into a
    // pair of (instructions, finalPrompt) the helper-side LanguageModelSession
    // can consume. The full Transcript-API port lands when the helper grows
    // an op for sending native entries; until then this textual flattening
    // is the source of truth.
    let prepared: ReturnType<typeof makeContext>;
    try {
      prepared = makeContext({
        messages: request.messages,
        tools: effectiveTools,
        injectToolInstructions: effectiveTools != null && effectiveTools.length > 0,
        responseFormat: request.response_format,
      });
    } catch (err) {
      return c.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const { instructions, finalPrompt: promptText } = prepared;

    let session: Session;
    try {
      session = await Session.open(config.backend, backend, instructions);
    } catch (err) {
      const classified = AfmError.reclassifyForBackend(AfmError.classify(err), backend);
      return c.json(
        {
          error: {
            message: AfmError.openAIMessage(classified),
            type: AfmError.openAIType(classified),
          },
        },
        AfmError.httpStatusCode(classified) as 400 | 401 | 403 | 404 | 429 | 500 | 503,
      );
    }

    const requestId = `chatcmpl-${cryptoRandomId()}`;
    const created = Math.floor(Date.now() / 1000);
    const modelName = ModelBackend.canonicalModelID(backend);
    // When the client asked for JSON output, strip any markdown fences off
    // the model's response. Apple's on-device model sometimes wraps JSON in
    // ```json ... ``` despite our explicit instructions otherwise.
    const wantsJson =
      request.response_format?.type === "json_object" ||
      request.response_format?.type === "json_schema";
    const cleanContent = (raw: string): string => (wantsJson ? JSONFenceStripper.strip(raw) : raw);

    // MARK: - Streaming branch
    if (request.stream) {
      const includeUsage = request.stream_options?.include_usage === true;
      return streamSSE(c, async (stream) => {
        // Role chunk first (OpenAI wire format).
        await stream.writeSSE({
          data: JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
                logprobs: null,
              },
            ],
          }),
        });

        let completionTokens = 0;
        let finishReason: string = FinishReason.openAIValue("stop");
        try {
          for await (const event of session.stream(
            promptText,
            {
              temperature: request.temperature,
              maxTokens: request.max_tokens,
              seed: request.seed,
            },
            c.req.raw.signal,
          )) {
            if (event.kind === "delta") {
              await stream.writeSSE({
                data: JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: event.text },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                }),
              });
            } else {
              completionTokens = event.usage.completionTokens;
              finishReason = event.finishReason;
            }
          }
        } catch (err) {
          const classified = AfmError.reclassifyForBackend(AfmError.classify(err), backend);
          debug(`stream error: ${AfmError.cliLabel(classified)}`);
          await stream.writeSSE({
            data: JSON.stringify({
              error: {
                message: AfmError.openAIMessage(classified),
                type: AfmError.openAIType(classified),
              },
            }),
          });
          await stream.writeSSE({ data: "[DONE]" });
          await session.close();
          return;
        }

        // Final finish chunk.
        await stream.writeSSE({
          data: JSON.stringify({
            id: requestId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: finishReason,
                logprobs: null,
              },
            ],
          }),
        });

        if (includeUsage) {
          await stream.writeSSE({
            data: JSON.stringify({
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [],
              usage: {
                prompt_tokens: Math.max(1, Math.floor(promptText.length / 4)),
                completion_tokens: completionTokens,
                total_tokens: Math.max(1, Math.floor(promptText.length / 4)) + completionTokens,
              },
            }),
          });
        }

        await stream.writeSSE({ data: "[DONE]" });
        await session.close();
      });
    }

    // MARK: - Non-streaming branch
    try {
      const result = await session.respond(promptText, {
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        seed: request.seed,
      });

      // Tool-call detection: when the model emitted the documented
      // {"tool_calls": ...} envelope, surface it as proper OpenAI
      // tool_calls on the assistant message with finish_reason=tool_calls.
      const calls = effectiveTools && effectiveTools.length > 0
        ? ToolCallHandler.detectToolCall(result.content)
        : null;

      // MCP auto-execute: when MCP injected the tool list, we run the tool
      // ourselves and re-prompt for the final natural-language answer.
      if (calls && calls.length > 0 && resolved.injected && config.mcpClients) {
        const executed = await runMcpTools(calls, config.mcpClients, debug);
        const followupPrompt = buildToolFollowupPrompt(promptText, executed);
        const followup = await session.respond(followupPrompt, {
          temperature: request.temperature,
          maxTokens: request.max_tokens,
          seed: request.seed,
        });
        return c.json({
          id: requestId,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: cleanContent(followup.content) },
              finish_reason: followup.finishReason,
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: result.usage.promptTokens + followup.usage.promptTokens,
            completion_tokens: result.usage.completionTokens + followup.usage.completionTokens,
            total_tokens: result.usage.totalTokens + followup.usage.totalTokens,
          },
        });
      }

      if (calls && calls.length > 0) {
        const finishReason = FinishReason.openAIValue(
          FinishReasonResolver.resolve({
            hasToolCalls: true,
            completionTokens: result.usage.completionTokens,
            maxTokens: request.max_tokens,
          }),
        );
        return c.json({
          id: requestId,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.argumentsString },
                })),
              },
              finish_reason: finishReason,
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: result.usage.promptTokens,
            completion_tokens: result.usage.completionTokens,
            total_tokens: result.usage.totalTokens,
          },
        });
      }

      return c.json({
        id: requestId,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: cleanContent(result.content) },
            finish_reason: result.finishReason,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
      });
    } catch (err) {
      const classified = AfmError.reclassifyForBackend(AfmError.classify(err), backend);
      debug(`chat completion error: ${AfmError.cliLabel(classified)} ${AfmError.openAIMessage(classified)}`);
      return c.json(
        {
          error: {
            message: AfmError.openAIMessage(classified),
            type: AfmError.openAIType(classified),
          },
        },
        AfmError.httpStatusCode(classified) as 400 | 401 | 403 | 404 | 429 | 500 | 503,
      );
    } finally {
      await session.close();
    }
  });

  return app;
}

function cryptoRandomId(): string {
  // 12-char base16 — matches apfel-plus's chatcmpl-xxxxxxxxxxxx shape.
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ExecutedToolCall {
  name: string;
  args: string;
  result: string;
  isError: boolean;
}

/**
 * Execute every detected tool call against the registered MCP clients.
 * Tries each client in order until one of them lists the named tool; if no
 * client claims the tool we surface a structured error.
 */
async function runMcpTools(
  calls: { id: string; name: string; argumentsString: string }[],
  clients: McpStdioClient[],
  debug: (msg: string) => void,
): Promise<ExecutedToolCall[]> {
  const out: ExecutedToolCall[] = [];
  for (const call of calls) {
    let executed = false;
    for (const client of clients) {
      try {
        // Tools are cached in McpStdioClient, so we can call callTool directly
        // If the tool doesn't exist, callTool will fail and we'll try the next client
        const result = await client.callTool(call.name, call.argumentsString);
        out.push({ name: call.name, args: call.argumentsString, result, isError: false });
      } catch (err) {
        // Try the next client if this one doesn't have the tool or failed
        continue;
      }
      executed = true;
      break;
    }
    if (!executed) {
      out.push({
        name: call.name,
        args: call.argumentsString,
        result: `tool '${call.name}' not found on any registered MCP server`,
        isError: true,
      });
    }
  }
  return out;
}

function buildToolFollowupPrompt(userPrompt: string, executed: ExecutedToolCall[]): string {
  const formatted = executed
    .map((e) => (e.isError ? `${e.name} (error): ${e.result}` : `${e.name}: ${e.result}`))
    .join("\n");
  return `The user asked: ${userPrompt}\n\nThe tool returned:\n${formatted}\n\nAnswer the user's question using this result.`;
}
