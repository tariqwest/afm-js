// ============================================================================
// serve.ts — `afm-js serve` subcommand. Starts the OpenAI-compatible HTTP
// server, locates the helper binary, handles SIGINT/SIGTERM cleanly.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { startServer } from "@afm-js/server";

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description: "Run the OpenAI-compatible HTTP server.",
  },
  args: {
    port: {
      type: "string",
      description: "Bind port (default 1337).",
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
    backend: {
      type: "string",
      description: "Force backend: 'fm' for /usr/bin/fm CLI, 'helper' for afm-fm-helper (default: auto-detect).",
    },
    helper: {
      type: "string",
      description: "Override the afm-fm-helper binary path (defaults to bundled prebuilt).",
    },
    mcp: {
      type: "string",
      description:
        "Spec for a local stdio MCP server. Format: '<cmd> <arg1> <arg2>'. Repeatable via colon-separated list.",
    },
  },
  async run({ args }) {
    const debugFn = args.debug ? (msg: string) => process.stderr.write(`afm-js: ${msg}\n`) : undefined;
    const helperBinaryPath = resolveHelperPath(args.helper as string | undefined);

    // Support environment variables for port and token (useful for brew services)
    const port = args.port ? Number(args.port) : (process.env.AFM_JS_PORT ? Number(process.env.AFM_JS_PORT) : 1337);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      process.stderr.write(`afm-js: invalid --port value: ${args.port}\n`);
      process.exit(2);
    }

    const token = (args.token as string | undefined) ?? process.env.AFM_JS_TOKEN ?? "sk-apple-1337";

    const mcpServers = parseMcpSpecs(args.mcp as string | undefined);

    const server = await startServer({
      helperBinaryPath,
      port,
      host: (args.host as string | undefined) ?? "127.0.0.1",
      token,
      mcpServers,
      debug: debugFn,
      backend: args.backend ? { force: args.backend as "fm" | "helper" } : undefined,
    });

    process.stdout.write(
      `afm-js serving on http://${args.host ?? "127.0.0.1"}:${port} ` +
        `(helper: ${helperBinaryPath})\n`,
    );

    let stopping = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`afm-js: received ${signal}, shutting down\n`);
      await server.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  },
});

/**
 * Parse `--mcp` argument. Supports a single spec ("python3 server.py") or a
 * colon-separated list of specs. Whitespace inside a spec is split into the
 * (command, args[]) pair.
 */
function parseMcpSpecs(raw: string | undefined): { command: string; args: string[] }[] {
  if (!raw) return [];
  const specs = raw.split(":").map((s) => s.trim()).filter(Boolean);
  return specs.map((s) => {
    const parts = s.split(/\s+/);
    return { command: parts[0] as string, args: parts.slice(1) };
  });
}

/**
 * Locate the helper binary. Precedence:
 *   1. Explicit --helper flag.
 *   2. AFM_HELPER_PATH env var.
 *   3. Bundled at packages/afm-js/dist/../helper/.build/release/afm-fm-helper (dev only).
 *   4. Sibling helper repo at ../../helper/.build/release/afm-fm-helper (workspace dev).
 */
function resolveHelperPath(override?: string): string {
  const candidates = [
    override,
    process.env.AFM_HELPER_PATH,
    // Dev: from packages/afm-js/dist/commands/serve.js up to workspace root then helper/
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "..",
      "helper",
      ".build",
      "release",
      "afm-fm-helper",
    ),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  process.stderr.write(
    "afm-js: could not locate the afm-fm-helper binary.\n" +
      "Set --helper /path/to/afm-fm-helper or AFM_HELPER_PATH=…\n" +
      "In dev: run `(cd helper && swift build -c release)` from the workspace root.\n",
  );
  process.exit(1);
}
