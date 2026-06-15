// ============================================================================
// server.ts — @hono/node-server bootstrap. Exposes startServer() so the
// umbrella CLI can spin up the API on a chosen port/host with the backend
// (fm CLI or helper) already wired in.
// ============================================================================

import { serve, type ServerType } from "@hono/node-server";
import { HelperProcessManager, UnifiedBackend, FmSocketClient, FmProcessManager } from "@afm-js/core";
import type { BackendSelectorOptions, Backend } from "./bridge/BackendSelector.js";
import { createApp } from "./app.js";
import { selectBackend } from "./bridge/BackendSelector.js";
import { McpStdioClient } from "./mcp/McpClient.js";

export interface McpServerSpec {
  /** Executable path or command (e.g. "python3"). */
  command: string;
  /** Args appended after `command`. */
  args?: string[];
}

export interface StartOptions {
  /** 
   * Absolute path to the afm-fm-helper binary. 
   * If not provided, auto-detection is used (fm CLI preferred on macOS 27+).
   */
  helperBinaryPath?: string;
  /** Backend selection options (auto-detect if not specified) */
  backend?: BackendSelectorOptions;
  /** Bind port. Default 11434. */
  port?: number;
  /** Bind host. Default 127.0.0.1. */
  host?: string;
  /** Bearer token to require on requests. Null/undefined disables auth. */
  token?: string | null;
  /** Local stdio-MCP servers whose tools are injected when the client sent none. */
  mcpServers?: McpServerSpec[];
  /** Debug log callback. */
  debug?: (msg: string) => void;
}

export interface RunningServer {
  /** Shut down the HTTP listener and the backend subprocess. */
  stop: () => Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const debug = opts.debug ?? (() => {});
  
  // Auto-detect or use specified backend
  const backend = await createBackend(opts, debug);
  
  const mcpClients: McpStdioClient[] = (opts.mcpServers ?? []).map(
    (s) => new McpStdioClient({ command: s.command, args: s.args, debug }),
  );

  const app = createApp({ backend, token: opts.token, debug, mcpClients });

  const port = opts.port ?? 11434;
  const hostname = opts.host ?? "127.0.0.1";

  return new Promise<RunningServer>((resolve) => {
    const server: ServerType = serve(
      { fetch: app.fetch, port, hostname },
      () => {
        const backendName = backend.getKind() === "fm" ? "fm CLI" : "helper";
        debug(`afm-js listening on http://${hostname}:${port} (backend: ${backendName})`);
        resolve({
          stop: () =>
            new Promise<void>((res) => {
              server.close(async () => {
                await Promise.allSettled(mcpClients.map((c) => c.shutdown()));
                await backend.shutdown();
                res();
              });
            }),
        });
      },
    );
  });
}

async function createBackend(opts: StartOptions, debug: (msg: string) => void): Promise<UnifiedBackend> {
  // Explicit helper path bypasses auto-detection
  if (opts.helperBinaryPath && !opts.backend?.force) {
    const manager = new HelperProcessManager(opts.helperBinaryPath, undefined, debug);
    return UnifiedBackend.createHelper(manager, debug);
  }

  const selectorOptions: BackendSelectorOptions = opts.backend ?? {};
  if (opts.helperBinaryPath) selectorOptions.helperPath = opts.helperBinaryPath;
  selectorOptions.debug = debug;

  debug("Auto-detecting backend (fm CLI preferred on macOS 27+)...");
  const detected = await selectBackend(selectorOptions);
  debug(`Detected backend: ${detected.kind}`);

  if (detected.kind === "fm") {
    const client = new FmSocketClient(detected.manager.getSocketPath());
    await client.connect();
    return new UnifiedBackend({
      kind: "fm",
      fmClient: client,
      processManager: detected.manager,
      debug,
    });
  } else {
    const client = new FmSocketClient(detected.socketPath);
    await client.connect();
    return new UnifiedBackend({
      kind: "helper",
      fmClient: client,
      processManager: detected.manager,
      debug,
    });
  }
}
