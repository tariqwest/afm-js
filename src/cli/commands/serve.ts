// ============================================================================
// serve.ts — `fm-server serve` subcommand. Starts the OpenAI-compatible HTTP
// server and handles SIGINT/SIGTERM cleanly.
// ============================================================================

import { defineCommand } from "citty";
import { startServer } from "../../server/index.js";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Run the OpenAI-compatible HTTP server.",
  },
  args: {
    port: {
      type: "string",
      description: "Bind port (default 11434).",
    },
    host: {
      type: "string",
      description: "Bind host (default 127.0.0.1).",
    },
    token: {
      type: "string",
      description: "Bearer token required on requests. Omit to disable auth.",
    },
    debug: {
      type: "boolean",
      description: "Verbose debug logging to stderr.",
    },
    mcp: {
      type: "string",
      description:
        "Spec for a local stdio MCP server. Format: '<cmd> <arg1> <arg2>'. Repeatable via colon-separated list.",
    },
  },
  async run({ args }) {
    const debugFn = args.debug ? (msg: string) => process.stderr.write(`fm-server: ${msg}\n`) : undefined;

    const port = args.port ? Number(args.port) : (process.env.FM_SERVER_PORT ? Number(process.env.FM_SERVER_PORT) : 11434);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      process.stderr.write(`fm-server: invalid --port value: ${args.port}\n`);
      process.exit(2);
    }

    const token = (args.token as string | undefined) ?? process.env.FM_SERVER_TOKEN ?? undefined;
    const host = (args.host as string | undefined) ?? "127.0.0.1";
    const mcpServers = parseMcpSpecs(args.mcp as string | undefined);

    const server = await startServer({
      port,
      host,
      token,
      mcpServers,
      debug: debugFn,
    });

    process.stdout.write(`fm-server serving on http://${host}:${port} (backend: apple-fm-sdk)\n`);

    let stopping = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`fm-server: received ${signal}, shutting down\n`);
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  },
});

function parseMcpSpecs(raw: string | undefined): { command: string; args: string[] }[] {
  if (!raw) return [];
  const specs = raw.split(":").map((s) => s.trim()).filter(Boolean);
  return specs.map((s) => {
    const parts = s.split(/\s+/);
    return { command: parts[0] as string, args: parts.slice(1) };
  });
}