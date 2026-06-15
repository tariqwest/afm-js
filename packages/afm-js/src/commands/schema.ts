// ============================================================================
// schema.ts — `afm-js schema object --name ... --string field1 ...`
// Generate a JSON schema for structured output.
// Mirrors Apple's `fm schema` command.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { HelperProcess, UnifiedBackend } from "@afm-js/server";

export const schemaCommand = defineCommand({
  meta: {
    name: "schema",
    description: "Generate a JSON schema for structured output.",
  },
  args: {
    type: {
      type: "positional",
      required: true,
      description: "Schema type: 'object' or 'array'.",
    },
    name: {
      type: "string",
      description: "Name of the schema root (for documentation).",
    },
    description: {
      type: "string",
      description: "Description of the schema.",
    },
    string: {
      type: "string",
      description: "Add a string field. Format: 'name' or 'name:description'.",
    },
    int: {
      type: "string",
      description: "Add an integer field. Format: 'name' or 'name:description'.",
    },
    number: {
      type: "string",
      description: "Add a number field. Format: 'name' or 'name:description'.",
    },
    bool: {
      type: "string",
      description: "Add a boolean field. Format: 'name' or 'name:description'.",
    },
    json: {
      type: "boolean",
      description: "Emit raw JSON schema.",
    },
  },
  async run({ args }) {
    const schemaType = String(args.type);
    if (schemaType !== "object" && schemaType !== "array") {
      process.stderr.write(`afm-js: schema type must be 'object' or 'array', got '${schemaType}'\n`);
      process.exit(2);
    }

    // Build schema from arguments
    const schema: Record<string, unknown> = {
      type: schemaType,
    };

    if (args.name) {
      schema.title = args.name;
    }
    if (args.description) {
      schema.description = args.description;
    }

    if (schemaType === "object") {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Parse string fields
      if (args.string) {
        for (const field of String(args.string).split(",")) {
          const parts = field.split(":");
          const name = parts[0]!;
          const desc = parts[1] ?? name;
          properties[name] = { type: "string", description: desc };
          required.push(name);
        }
      }

      // Parse int fields
      if (args.int) {
        for (const field of String(args.int).split(",")) {
          const parts = field.split(":");
          const name = parts[0]!;
          const desc = parts[1] ?? name;
          properties[name] = { type: "integer", description: desc };
          required.push(name);
        }
      }

      // Parse number fields
      if (args.number) {
        for (const field of String(args.number).split(",")) {
          const parts = field.split(":");
          const name = parts[0]!;
          const desc = parts[1] ?? name;
          properties[name] = { type: "number", description: desc };
          required.push(name);
        }
      }

      // Parse bool fields
      if (args.bool) {
        for (const field of String(args.bool).split(",")) {
          const parts = field.split(":");
          const name = parts[0]!;
          const desc = parts[1] ?? name;
          properties[name] = { type: "boolean", description: desc };
          required.push(name);
        }
      }

      schema.properties = properties;
      if (required.length > 0) {
        schema.required = required;
      }
    }

    if (args.json) {
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    } else {
      // Pretty print schema summary
      process.stdout.write(`Schema: ${schema.title || "unnamed"}\n`);
      process.stdout.write(`Type: ${schemaType}\n`);
      if (schema.description) {
        process.stdout.write(`Description: ${schema.description}\n`);
      }
      if (schemaType === "object" && schema.properties) {
        process.stdout.write("\nProperties:\n");
        for (const [name, prop] of Object.entries(schema.properties as Record<string, { type: string; description: string }>)) {
          process.stdout.write(`  ${name}: ${prop.type}${(schema.required as string[] | undefined)?.includes(name) ? " (required)" : ""}\n`);
        }
      }
      process.stdout.write(`\nJSON:\n${JSON.stringify(schema, null, 2)}\n`);
    }
  },
});
