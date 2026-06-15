// ============================================================================
// BackendSelector.ts — Auto-detect and select between /usr/bin/fm CLI and
// afm-fm-helper binary. Spawns fm serve --socket when available, falls back
// to helper-based JSON IPC.
// ============================================================================

import { FmProcessManager, HelperProcessManager, type FmProcess, type HelperProcessHandle } from "@afm-js/core";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type BackendKind = "fm" | "helper";

export interface FmBackend {
  kind: "fm";
  manager: FmProcessManager;
}

export interface HelperBackend {
  kind: "helper";
  manager: HelperProcessManager;
  socketPath: string;
}

export type Backend = FmBackend | HelperBackend;

export interface BackendSelectorOptions {
  /** Prefer fm CLI even if both are available */
  preferFm?: boolean;
  /** Force specific backend */
  force?: BackendKind;
  /** Socket path for fm (auto-generated if not provided) */
  socketPath?: string;
  /** Helper binary path (auto-detected if not provided) */
  helperPath?: string;
  /** Debug log callback */
  debug?: (msg: string) => void;
}

async function findHelperBinary(): Promise<string | null> {
  // Try multiple locations:
  // 1. Bundled in node_modules/@afm-js/fm-helper-darwin-arm64
  // 2. Local build in helper/.build/debug/afm-fm-helper
  // 3. Adjacent to server package

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const candidates = [
    // Bundled package
    join(__dirname, "../../../..", "node_modules", "@afm-js", "fm-helper-darwin-arm64", "bin", "afm-fm-helper"),
    // Local build
    join(__dirname, "../../../..", "helper", ".build", "debug", "afm-fm-helper"),
    join(__dirname, "../../../..", "helper", ".build", "release", "afm-fm-helper"),
    // Adjacent
    join(__dirname, "..", "..", "afm-fm-helper"),
  ];

  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Detect and spawn the best available backend.
 * Priority: fm CLI (macOS 27+) > afm-fm-helper
 */
export async function selectBackend(options: BackendSelectorOptions = {}): Promise<Backend> {
  const { force, socketPath, helperPath, debug } = options;

  // If forced, use that backend
  if (force === "helper") {
    return spawnHelper(helperPath, debug);
  }
  if (force === "fm") {
    return spawnFm(socketPath);
  }

  // Check for fm availability
  const fmAvailable = await FmProcessManager.isAvailable();

  if (fmAvailable) {
    try {
      return await spawnFm(socketPath);
    } catch (err) {
      console.warn("Failed to spawn fm CLI, falling back to helper:", err);
      return spawnHelper(helperPath, debug);
    }
  }

  // Fall back to helper
  return spawnHelper(helperPath, debug);
}

async function spawnFm(socketPath?: string): Promise<FmBackend> {
  const manager = new FmProcessManager(socketPath);
  const proc = await manager.spawn();

  return {
    kind: "fm",
    manager,
  };
}

async function spawnHelper(helperPath?: string, debug?: (msg: string) => void): Promise<HelperBackend> {
  const binaryPath = helperPath ?? (await findHelperBinary());

  if (!binaryPath) {
    throw new Error(
      "Neither /usr/bin/fm nor afm-fm-helper binary found. " +
        "Please install afm-js on macOS 27+ or build the helper binary."
    );
  }

  const manager = new HelperProcessManager(binaryPath, undefined, debug);
  const proc = await manager.spawn();

  return {
    kind: "helper",
    manager,
    socketPath: proc.socketPath,
  };
}

/**
 * Check which backends are available without spawning them
 */
export async function checkBackendAvailability(): Promise<{
  fm: boolean;
  helper: boolean;
}> {
  const [fm, helper] = await Promise.all([
    FmProcessManager.isAvailable(),
    findHelperBinary().then((p) => p !== null),
  ]);

  return { fm, helper };
}
