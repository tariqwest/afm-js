// ============================================================================
// UnifiedBackend.ts — Abstraction over afm-fm-helper and /usr/bin/fm.
// Both backends now speak HTTP/1.1 over a Unix domain socket, so this class
// is a thin adapter: it wraps FmSocketClient + a process manager reference
// and translates the internal helper-wire protocol into HTTP calls.
// ============================================================================

import { FmSocketClient, FmProcessManager } from "../fm/index.js";
import { AfmError } from "../errors/AfmError.js";
import type {
  HelperRequest,
  HelperReply,
  HelperOkAvailability,
  HelperOkOpenSession,
  HelperOkRespond,
  HelperOkSimple,
  HelperStreamFrame,
} from "./HelperProcess.js";
import type { HelperProcessManager } from "./HelperProcessManager.js";

export type BackendKind = "fm" | "helper";

export interface UnifiedBackendOptions {
  kind: BackendKind;
  /** HTTP-over-socket client (used for both backends) */
  fmClient: FmSocketClient;
  /** Process manager used for shutdown — either FmProcessManager or HelperProcessManager */
  processManager?: { shutdown(): Promise<void> };
  debug?: (msg: string) => void;
}

export class UnifiedBackend {
  private kind: BackendKind;
  private fmClient: FmSocketClient;
  private processManager?: { shutdown(): Promise<void> };
  private debug: (msg: string) => void;
  private nextId = 0;
  private sessionCounter = 0;
  private sessions = new Map<string, { backend: "on_device" | "pcc"; instructions?: string }>();
  private shuttingDown = false;

  constructor(opts: UnifiedBackendOptions) {
    this.kind = opts.kind;
    this.fmClient = opts.fmClient;
    this.processManager = opts.processManager;
    this.debug = opts.debug ?? (() => {});
  }

  // ── Factory helpers ────────────────────────────────────────────────────────

  static async createFm(socketPath?: string, debug?: (msg: string) => void): Promise<UnifiedBackend> {
    const manager = new FmProcessManager(socketPath);
    const proc = await manager.spawn();
    const client = new FmSocketClient(proc.socketPath);
    await client.connect();
    return new UnifiedBackend({ kind: "fm", fmClient: client, processManager: manager, debug });
  }

  static async createHelper(
    manager: HelperProcessManager,
    debug?: (msg: string) => void,
  ): Promise<UnifiedBackend> {
    const proc = await manager.spawn();
    const client = new FmSocketClient(proc.socketPath);
    await client.connect();
    return new UnifiedBackend({ kind: "helper", fmClient: client, processManager: manager, debug });
  }

  getKind(): BackendKind {
    return this.kind;
  }

  // ── Protocol bridge ────────────────────────────────────────────────────────

  /** Translate a HelperRequest into an HTTP call and return a HelperReply. */
  async request(req: HelperRequest, _timeoutMs = 60_000): Promise<HelperReply> {
    if (this.shuttingDown) throw new Error("Backend is shutting down");
    const id = `r${++this.nextId}`;
    return this.httpRequest(id, req);
  }

  /** Translate a streaming HelperRequest into SSE frames. */
  streamRequest(req: HelperRequest, signal?: AbortSignal): AsyncIterable<HelperStreamFrame> {
    if (this.shuttingDown) throw new Error("Backend is shutting down");
    const id = `r${++this.nextId}`;
    return this.httpStreamRequest(id, req, signal);
  }

  /** Convenience: request with automatic error classification. */
  async call<T extends HelperReply>(req: HelperRequest): Promise<T & { ok: true }> {
    const reply = await this.request(req);
    if ("ok" in reply && reply.ok === true) return reply as T & { ok: true };
    if (!("ok" in reply) || reply.ok !== false) {
      throw new Error(`UnifiedBackend.call: unexpected reply shape for op '${req.op}'`);
    }
    const err = reply.error;
    switch (err.kind) {
      case "pccUnavailable":   throw AfmError.classify({ kind: "pccUnavailable", reason: err.reason ?? err.message });
      case "pccQuotaExceeded": throw AfmError.classify({ kind: "pccQuotaExceeded" });
      case "pccNetworkFailure":throw AfmError.classify({ kind: "pccNetworkFailure", message: err.message });
      case "decodingFailure":  throw AfmError.classify({ kind: "decodingFailure", message: err.message });
      default:                 throw AfmError.classify({ kind: "unknown", message: err.message });
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.sessions.clear();
    this.fmClient.close();
    await this.processManager?.shutdown();
  }

  // ── HTTP implementation (shared by both backends) ──────────────────────────

  private async httpRequest(id: string, req: HelperRequest): Promise<HelperReply> {
    switch (req.op) {
      case "availability": {
        const response = await this.fmClient.request("GET", "/v1/models");
        const body = JSON.parse(response.body.toString("utf-8"));
        const hasModel = body.data?.some((m: { id: string }) => m.id === "system" || m.id === "pcc");
        const status: HelperOkAvailability["status"] = hasModel ? "available" : "unknownUnavailable";
        return { ok: true, id, status } satisfies HelperOkAvailability;
      }

      case "openSession": {
        const session = `s${++this.sessionCounter}`;
        this.sessions.set(session, {
          backend: req.backend ?? "on_device",
          instructions: req.instructions,
        });
        return { ok: true, id, session } satisfies HelperOkOpenSession;
      }

      case "respond": {
        if (!req.prompt) return this.makeError(id, "decodingFailure", "Missing prompt");
        const sessionState = req.session ? this.sessions.get(req.session) : undefined;
        if (req.session && !sessionState && !req.backend && !req.instructions) {
          return this.makeError(id, "unknown", `Unknown session: ${req.session}`);
        }
        const backend = req.backend ?? sessionState?.backend ?? "on_device";
        const instructions = req.instructions ?? sessionState?.instructions;
        const model = backend === "pcc" ? "pcc" : "system";
        const response = await this.fmClient.request("POST", "/v1/chat/completions", {
          model,
          messages: this.buildMessages(req.prompt, instructions),
          temperature: req.options?.temperature,
          max_tokens: req.options?.maxTokens,
          seed: req.options?.seed,
        });
        if (response.statusCode >= 400) return this.handleHttpError(id, response);
        const body = JSON.parse(response.body.toString("utf-8"));
        const choice = body.choices?.[0];
        return {
          ok: true, id,
          content: choice?.message?.content ?? "",
          finishReason: choice?.finish_reason ?? "stop",
          usage: {
            promptTokens: body.usage?.prompt_tokens ?? 0,
            completionTokens: body.usage?.completion_tokens ?? 0,
            totalTokens: body.usage?.total_tokens ?? 0,
          },
        } satisfies HelperOkRespond;
      }

      case "closeSession":
        if (req.session) {
          this.sessions.delete(req.session);
        }
        return { ok: true, id } satisfies HelperOkSimple;
      case "shutdown":
        return { ok: true, id } satisfies HelperOkSimple;

      default:
        return this.makeError(id, "unknown", `Unsupported op: ${req.op}`);
    }
  }

  private async *httpStreamRequest(
    id: string,
    req: HelperRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<HelperStreamFrame> {
    if (req.op !== "stream") {
      yield this.makeStreamError(id, "unknown", `streamRequest only supports 'stream' op, got ${req.op}`);
      return;
    }
    if (!req.prompt) {
      yield this.makeStreamError(id, "decodingFailure", "Missing prompt");
      return;
    }

    const sessionState = req.session ? this.sessions.get(req.session) : undefined;
    if (req.session && !sessionState && !req.backend && !req.instructions) {
      yield this.makeStreamError(id, "unknown", `Unknown session: ${req.session}`);
      return;
    }
    const backend = req.backend ?? sessionState?.backend ?? "on_device";
    const instructions = req.instructions ?? sessionState?.instructions;
    const model = backend === "pcc" ? "pcc" : "system";
    const abortController = new AbortController();
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => abortController.abort();
      signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      const stream = this.fmClient.streamSSE(
        "POST",
        "/v1/chat/completions",
        {
          model,
          messages: this.buildMessages(req.prompt, instructions),
          stream: true,
          temperature: req.options?.temperature,
          max_tokens: req.options?.maxTokens,
          seed: req.options?.seed,
        },
        {},
        abortController.signal,
      );

      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      for await (const chunk of stream) {
        if (abortController.signal.aborted) return;
        
        // Validate chunk structure
        if (!chunk || typeof chunk !== 'object') {
          continue; // Skip invalid chunks
        }
        
        const delta = chunk as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };
        
        // Validate choices array if present
        if (delta.choices && !Array.isArray(delta.choices)) {
          continue;
        }
        
        const content = delta.choices?.[0]?.delta?.content;
        const finishReason = delta.choices?.[0]?.finish_reason;

        if (content) yield { id, event: "delta", text: content } satisfies HelperStreamFrame;
        if (delta.usage) {
          usage = {
            promptTokens: delta.usage.prompt_tokens,
            completionTokens: delta.usage.completion_tokens,
            totalTokens: delta.usage.total_tokens,
          };
        }
        if (finishReason) {
          yield { id, event: "done", finishReason, usage } satisfies HelperStreamFrame;
          return;
        }
      }

      yield { id, event: "done", finishReason: "stop", usage } satisfies HelperStreamFrame;
    } catch (err) {
      yield this.makeStreamError(id, "unknown", err instanceof Error ? err.message : String(err));
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  // ── Error helpers ──────────────────────────────────────────────────────────

  private handleHttpError(id: string, response: { statusCode: number; body: Buffer }): HelperReply {
    let errorKind = "unknown";
    let message = `HTTP ${response.statusCode}`;
    try {
      const body = JSON.parse(response.body.toString("utf-8"));
      message = body.error?.message ?? message;
      if (message.includes("quota") || message.includes("quotaLimitReached")) errorKind = "pccQuotaExceeded";
      else if (message.includes("network") || message.includes("networkFailure")) errorKind = "pccNetworkFailure";
      else if (message.includes("unavailable") || message.includes("deviceNotEligible")) errorKind = "pccUnavailable";
    } catch { /* use defaults */ }
    return { ok: false, id, error: { kind: errorKind, message } };
  }

  private makeError(id: string, kind: string, message: string): HelperReply {
    return { ok: false, id, error: { kind, message } };
  }

  private makeStreamError(id: string, kind: string, message: string): HelperStreamFrame {
    return { ok: false, id, error: { kind, message } };
  }

  private buildMessages(prompt: string, instructions?: string): Array<{ role: "system" | "user"; content: string }> {
    if (instructions) {
      return [
        { role: "system", content: instructions },
        { role: "user", content: prompt },
      ];
    }
    return [{ role: "user", content: prompt }];
  }
}
