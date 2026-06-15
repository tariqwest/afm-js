// ============================================================================
// McpClient.ts — Stdio MCP client. Spawns an MCP server subprocess, speaks
// JSON-RPC 2.0 over its stdin/stdout, and exposes:
//   - listTools()    -> the OpenAI-shaped tool descriptors
//   - call(name, args) -> the textual result content
//
// The remote (SSE / fetch) transport lands in M3; the wire types are shared.
//
// Port of Sources/MCPClient.swift (the stdio side).
// ============================================================================

import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  BufferedLineReader,
  type McpResponse,
  type McpToolCallResult,
  type McpToolsListResult,
  type OpenAITool,
  mcpToolToOpenAI,
} from "@afm-js/core";

export interface McpClientOptions {
  /** Absolute path or argv[0] to launch (e.g. "python3", "node"). */
  command: string;
  /** Args to pass after the command, e.g. ["/path/server.py"]. */
  args?: string[];
  /** Optional bearer token for remote servers (no-op in stdio). */
  bearerToken?: string;
  /** Per-call timeout in ms. Defaults to 15000. */
  timeoutMs?: number;
  /** Debug callback. */
  debug?: (msg: string) => void;
}

interface Pending {
  resolve: (value: McpResponse) => void;
  reject: (err: unknown) => void;
}

export class McpStdioClient {
  private child: ChildProcess | null = null;
  private reader = new BufferedLineReader();
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private initialized = false;
  private readonly opts: Required<Omit<McpClientOptions, "bearerToken">> & Pick<McpClientOptions, "bearerToken">;
  private cachedTools: OpenAITool[] | null = null;
  private toolsCacheTime = 0;
  private readonly toolsCacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(opts: McpClientOptions) {
    this.opts = {
      args: [],
      timeoutMs: 15_000,
      debug: () => {},
      ...opts,
    };
  }

  /** Start the subprocess and run the MCP `initialize` handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.initialized) return;
    if (!this.child) {
      this.opts.debug(`mcp: spawning ${this.opts.command} ${this.opts.args.join(" ")}`);
      this.child = spawn(this.opts.command, this.opts.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stdout?.setEncoding("utf8");
      this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
      this.child.stderr?.setEncoding("utf8");
      this.child.stderr?.on("data", (chunk: string) =>
        this.opts.debug(`mcp stderr: ${chunk.trim()}`),
      );
      this.child.on("exit", (code, signal) => {
        this.opts.debug(`mcp exited code=${code} signal=${signal}`);
        this.failAllPending(new Error(`mcp server exited code=${code} signal=${signal}`));
        this.child = null;
        this.initialized = false;
        this.cachedTools = null;
        this.toolsCacheTime = 0;
      });
    }
    // Standard MCP handshake.
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "afm-js", version: "0.0.1" },
    });
    await this.notify("notifications/initialized", {});
    // Check if process is still alive after handshake (race condition fix)
    if (!this.child || this.child.killed) {
      throw new Error("mcp server exited during initialization");
    }
    this.initialized = true;
  }

  async listTools(): Promise<OpenAITool[]> {
    const now = Date.now();
    if (this.cachedTools && (now - this.toolsCacheTime) < this.toolsCacheTtlMs) {
      return this.cachedTools;
    }

    await this.start();
    try {
      const reply = await this.request("tools/list", {});
      if (reply.error) {
        throw new Error(`mcp tools/list failed: ${reply.error.message}`);
      }
      const result = reply.result as McpToolsListResult | undefined;
      const tools = (result?.tools ?? []).map(mcpToolToOpenAI);
      this.cachedTools = tools;
      this.toolsCacheTime = now;
      return tools;
    } catch (err) {
      // If we have cached tools, return them even on error to avoid breaking requests
      if (this.cachedTools) {
        this.opts.debug(`mcp tools/list failed, using cached tools: ${err}`);
        return this.cachedTools;
      }
      throw err;
    }
  }

  async callTool(name: string, args: string): Promise<string> {
    await this.start();
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(args || "{}");
    } catch {
      parsedArgs = { value: args };
    }
    const reply = await this.request("tools/call", { name, arguments: parsedArgs });
    if (reply.error) {
      throw new Error(`mcp tool '${name}' failed: ${reply.error.message}`);
    }
    const result = reply.result as McpToolCallResult | undefined;
    if (!result?.content) return "";
    const text = result.content
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (result.isError) {
      throw new Error(text || `mcp tool '${name}' returned an error`);
    }
    return text;
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    try {
      // No standard "shutdown" RPC in MCP; just close stdin and SIGTERM if needed.
      this.child.stdin?.end();
      await delay(100);
    } finally {
      this.child?.kill("SIGTERM");
      this.child = null;
      this.initialized = false;
    }
  }

  // MARK: - JSON-RPC plumbing

  private async request(method: string, params: unknown): Promise<McpResponse> {
    if (!this.child?.stdin) throw new Error("mcp: stdin not available");
    const id = ++this.nextId;
    const body = { jsonrpc: "2.0" as const, id, method, params };
    const line = `${JSON.stringify(body)}\n`;
    const wait = new Promise<McpResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(line);
    const timeoutPromise = (async () => {
      await delay(this.opts.timeoutMs);
      throw new Error(`mcp: '${method}' timed out after ${this.opts.timeoutMs}ms`);
    })();
    try {
      return await Promise.race([wait, timeoutPromise]);
    } finally {
      this.pending.delete(id);
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (!this.child?.stdin) throw new Error("mcp: stdin not available");
    const body = { jsonrpc: "2.0" as const, method, params };
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
  }

  private onStdout(chunk: string): void {
    for (const line of this.reader.push(chunk)) {
      let parsed: McpResponse;
      try {
        parsed = JSON.parse(line) as McpResponse;
      } catch (err) {
        this.opts.debug(`mcp: malformed line dropped (${err}): ${line}`);
        continue;
      }
      if (typeof parsed.id !== "number") {
        // Notifications from the server (e.g. logging). Ignored for M2.
        continue;
      }
      const p = this.pending.get(parsed.id);
      if (!p) {
        this.opts.debug(`mcp: reply for unknown id ${parsed.id}, dropping`);
        continue;
      }
      p.resolve(parsed);
    }
  }

  private failAllPending(err: unknown): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
