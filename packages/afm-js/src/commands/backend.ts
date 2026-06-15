// ============================================================================
// backend.ts — Shared CLI backend factory.
// Auto-selects the best available backend: fm CLI (preferred on macOS 27+)
// falling back to afm-fm-helper. Respects --helper / AFM_HELPER_PATH overrides.
// ============================================================================

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperProcess, UnifiedBackend, selectBackend } from "@afm-js/server";
import { FmSocketClient, FmProcessManager } from "@afm-js/core";

export interface BackendHandle {
  backend: UnifiedBackend;
  shutdown: () => Promise<void>;
}

/**
 * Resolve and start the best available backend for CLI use.
 *
 * Priority:
 *   1. Explicit `--helper PATH` or `AFM_HELPER_PATH` env var → use helper directly.
 *   2. Auto-detect: /usr/bin/fm (macOS 27+) preferred, falls back to afm-fm-helper.
 */
export async function createBackend(helperOverride?: string): Promise<BackendHandle> {
  const explicitHelper = helperOverride ?? process.env.AFM_HELPER_PATH;

  if (explicitHelper) {
    if (!existsSync(explicitHelper)) {
      process.stderr.write(`afm-js: helper binary not found: ${explicitHelper}\n`);
      process.exit(1);
    }
    const helper = new HelperProcess({ binaryPath: explicitHelper });
    helper.start();
    const backend = UnifiedBackend.createHelper(helper);
    return {
      backend,
      shutdown: () => backend.shutdown(),
    };
  }

  // Auto-detect
  let detected;
  try {
    detected = await selectBackend({ helperPath: resolveDefaultHelperPath() ?? undefined });
  } catch (err) {
    process.stderr.write(
      `afm-js: could not start any backend.\n` +
        `  Install afm-js on macOS 27+ for fm CLI support, or build the helper:\n` +
        `  (cd helper && swift build -c release)\n`,
    );
    process.exit(1);
  }

  if (detected.kind === "fm") {
    const fm = detected.process;
    const client = new FmSocketClient(fm.socketPath);
    await client.connect();
    const manager = new FmProcessManager(fm.socketPath);
    const backend = new UnifiedBackend({ kind: "fm", fmClient: client, fmProcessManager: manager });
    return { backend, shutdown: () => backend.shutdown() };
  } else {
    const backend = UnifiedBackend.createHelper(detected.helper);
    return { backend, shutdown: () => backend.shutdown() };
  }
}

function resolveDefaultHelperPath(): string | null {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const candidate = resolve(__dirname, "..", "..", "..", "..", "helper", ".build", "release", "afm-fm-helper");
  return existsSync(candidate) ? candidate : null;
}
