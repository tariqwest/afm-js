// ============================================================================
// available.ts — `afm-js available`. Check if Foundation Models are available.
// Mirrors Apple's `fm available` command.
// ============================================================================

import { defineCommand } from "citty";
import { createBackend } from "./backend.js";

export const availableCommand = defineCommand({
  meta: {
    name: "available",
    description: "Check if Foundation Models are available on this device.",
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
      const reply = await backend.call({ op: "availability" });
      const status = (reply as unknown as { status: string }).status ?? "unknownUnavailable";
      const isAvailable = status === "available";
      
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            available: isAvailable,
            status: status,
          })}\n`,
        );
      } else {
        if (isAvailable) {
          process.stdout.write("Foundation Models are available.\n");
        } else {
          process.stdout.write(`Foundation Models are not available: ${status}\n`);
        }
      }
      
      process.exit(isAvailable ? 0 : 1);
    } catch (err) {
      process.stderr.write(`afm-js: availability check failed: ${err}\n`);
      process.exit(1);
    } finally {
      await shutdown();
    }
  },
});
