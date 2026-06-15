// ============================================================================
// quota-usage.ts — `afm-js quota-usage`. Check PCC quota usage.
// Mirrors Apple's `fm quota-usage` command.
//
// The FM Client backend (/usr/bin/fm) may expose a /v1/quota endpoint.
// The helper backend does not support quota queries; outputs a clear message.
// ============================================================================

import { defineCommand } from "citty";
import { createBackend } from "./backend.js";

export const quotaUsageCommand = defineCommand({
  meta: {
    name: "quota-usage",
    description: "Check Private Cloud Compute (PCC) quota usage.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit a JSON envelope instead of plain text.",
    },
    helper: {
      type: "string",
      description: "Override the afm-fm-helper binary path.",
    },
  },
  async run({ args }) {
    const { backend, shutdown } = await createBackend(args.helper as string | undefined);

    try {
      if (backend.getKind() === "fm") {
        // FM backend: attempt /v1/quota endpoint
        const fmClient = (backend as unknown as { fmClient?: { request: (method: string, path: string) => Promise<{ statusCode: number; body: Buffer }> } }).fmClient;
        if (fmClient) {
          try {
            const response = await fmClient.request("GET", "/v1/quota");
            if (response.statusCode === 200) {
              const body = JSON.parse(response.body.toString("utf-8")) as Record<string, unknown>;
              if (args.json) {
                process.stdout.write(`${JSON.stringify(body)}\n`);
              } else {
                const used = body.used;
                const limit = body.limit;
                const remaining = body.remaining;
                if (used !== undefined && limit !== undefined) {
                  process.stdout.write(`PCC Quota: ${used} / ${limit} used\n`);
                  if (remaining !== undefined) {
                    process.stdout.write(`Remaining: ${remaining}\n`);
                  }
                } else {
                  process.stdout.write(`PCC quota: ${JSON.stringify(body)}\n`);
                }
              }
              return;
            }
          } catch {
            // Fall through to "not available" message
          }
        }
      }

      // Helper backend (or FM backend without /v1/quota): quota not available
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ available: false, reason: "Quota tracking requires the FM Client backend (/usr/bin/fm on macOS 27+)." })}\n`,
        );
      } else {
        process.stdout.write(
          "PCC quota information is not available on this backend.\n" +
            "Quota tracking requires the FM Client backend (/usr/bin/fm on macOS 27+).\n",
        );
      }
    } finally {
      await shutdown();
    }
  },
});
