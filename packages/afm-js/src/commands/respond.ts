// ============================================================================
// respond.ts — `afm-js respond "..."`. Generate a response to a prompt.
// Mirrors Apple's `fm respond` command semantics.
// ============================================================================

import { defineCommand } from "citty";
import { Session } from "@afm-js/server";
import { ModelBackend } from "@afm-js/core";
import { createBackend } from "./backend.js";

export const respondCommand = defineCommand({
  meta: {
    name: "respond",
    description: "Generate a response to a prompt.",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description: "The prompt text. If omitted, reads from stdin.",
    },
    model: {
      type: "string",
      description: "Model to use: 'system' (on-device, default) or 'pcc' (Private Cloud Compute).",
      default: "system",
    },
    stream: {
      type: "boolean",
      description: "Stream the response as it's generated.",
    },
    instructions: {
      type: "string",
      description: "System instructions for the session.",
    },
    temperature: {
      type: "string",
      description: "Sampling temperature (0.0-1.0).",
    },
    "max-tokens": {
      type: "string",
      description: "Maximum tokens to generate.",
    },
    seed: {
      type: "string",
      description: "Random seed for reproducible generation.",
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
    const promptText = args.text
      ? String(args.text)
      : await readAllStdin();
    if (!promptText.trim()) {
      process.stderr.write("afm-js: no prompt provided\n");
      process.exit(2);
    }

    const modelBackend = args.model === "pcc" ? ("privateCloudCompute" as const) : ("onDevice" as const);

    const { backend, shutdown } = await createBackend(args.helper as string | undefined);
    const session = await Session.open(
      backend,
      modelBackend,
      args.instructions as string | undefined,
    );

    const sessionOptions = {
      temperature: args.temperature ? parseFloat(args.temperature as string) : undefined,
      maxTokens: args["max-tokens"] ? parseInt(args["max-tokens"] as string, 10) : undefined,
      seed: args.seed ? parseInt(args.seed as string, 10) : undefined,
    };

    try {
      if (args.stream) {
        // Streaming response
        const stream = session.stream(promptText, sessionOptions);
        let fullContent = "";
        let finishReason = "unknown";
        let usage = undefined;
        
        for await (const event of stream) {
          if (event.kind === "delta" && event.text) {
            process.stdout.write(event.text);
            fullContent += event.text;
          } else if (event.kind === "done") {
            finishReason = event.finishReason;
            usage = event.usage;
          }
        }
        if (args.json) {
          process.stdout.write(
            `\n${JSON.stringify({
              model: ModelBackend.canonicalModelID(modelBackend),
              content: fullContent,
              finish_reason: finishReason,
              usage,
            })}\n`,
          );
        } else {
          process.stdout.write("\n");
        }
      } else {
        // Non-streaming response
        const result = await session.respond(promptText, sessionOptions);
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              model: ModelBackend.canonicalModelID(modelBackend),
              content: result.content,
              finish_reason: result.finishReason,
              usage: result.usage,
            })}\n`,
          );
        } else {
          process.stdout.write(`${result.content}\n`);
        }
      }
    } finally {
      await session.close();
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

