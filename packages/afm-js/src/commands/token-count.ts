// ============================================================================
// token-count.ts — `afm-js token-count "..."`. Count tokens without generating.
// Mirrors Apple's `fm token-count` command.
// ============================================================================

import { defineCommand } from "citty";
import { Session } from "@afm-js/server";
import { createBackend } from "./backend.js";

export const tokenCountCommand = defineCommand({
  meta: {
    name: "token-count",
    description: "Count tokens in a prompt or instructions without generating.",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description: "The text to count. If omitted, reads from stdin.",
    },
    instructions: {
      type: "string",
      description: "Instructions to include in token count.",
    },
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
    const text = args.text
      ? String(args.text)
      : await readAllStdin();
    if (!text.trim() && !args.instructions) {
      process.stderr.write("afm-js: no text or instructions provided\n");
      process.exit(2);
    }

    const { backend, shutdown } = await createBackend(args.helper as string | undefined);

    try {
      // Count tokens by doing a minimal respond call (max_tokens=1) and reading
      // usage.promptTokens from the response. Works on both FM and helper backends.
      const session = await Session.open(backend, "onDevice", args.instructions as string | undefined);
      try {
        const result = await session.respond(text.trim() || ".", { maxTokens: 1 });
        const promptTokens = result.usage.promptTokens;

        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              prompt_tokens: promptTokens,
              total_tokens: promptTokens,
            })}\n`,
          );
        } else {
          process.stdout.write(`${promptTokens}\n`);
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      process.stderr.write(`afm-js: token count failed: ${err}\n`);
      process.exit(1);
    } finally {
      await shutdown();
    }
  },
});

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise<string>((resolveStdin) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolveStdin(Buffer.concat(chunks).toString("utf8")));
  });
}

