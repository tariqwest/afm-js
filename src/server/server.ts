// ============================================================================
// server.ts — @hono/node-server bootstrap. Exposes startServer() so the
// umbrella CLI can spin up the API on a chosen port/host.
// ============================================================================

import { type ServerType, serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { McpStdioClient } from "./mcp/McpClient.js";
import { InferenceService } from "./sdk/InferenceService.js";

export interface McpServerSpec {
  /** Executable path or command (e.g. "python3"). */
  command: string;
  /** Args appended after `command`. */
  args?: string[];
}

export interface StartOptions {
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
  /** Shut down the HTTP listener and release SDK resources. */
  stop: () => Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const debug = opts.debug ?? (() => {});
  const inference = InferenceService.create();

  const mcpClients: McpStdioClient[] = (opts.mcpServers ?? []).map(
    (s) => new McpStdioClient({ command: s.command, args: s.args, debug }),
  );

  const app = createApp({ inference, token: opts.token, debug, mcpClients });

  const port = opts.port ?? 11434;
  const hostname = opts.host ?? "127.0.0.1";

  return new Promise<RunningServer>((resolve) => {
    const server: ServerType = serve({ fetch: app.fetch, port, hostname }, () => {
      debug(`fm-server listening on http://${hostname}:${port} (backend: apple-fm-sdk)`);
      resolve({
        stop: () =>
          new Promise<void>((res) => {
            server.close(async () => {
              await Promise.allSettled(mcpClients.map((c) => c.shutdown()));
              inference.shutdown();
              res();
            });
          }),
      });
    });
  });
}
