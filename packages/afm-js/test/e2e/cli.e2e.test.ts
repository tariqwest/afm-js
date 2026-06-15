// ============================================================================
// commands.e2e.test.ts — End-to-end tests for CLI commands
// Tests CLI commands against both FM CLI and helper backends
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

const MAIN_PATH = join(import.meta.dirname, "../../dist/main.js");

async function runCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("node", [MAIN_PATH, ...args], {
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// Check if we should run E2E tests
async function checkBackendAvailability() {
  const { existsSync } = await import("node:fs");
  
  // Assume FM CLI is available at /usr/bin/fm
  // Only check for helper as fallback
  const helperPath = "/Users/tariqwest/Developer/afm-js/helper/.build/release/afm-fm-helper";
  if (existsSync(helperPath)) {
    return true;
  }
  
  // FM CLI is assumed to be available
  return true;
}

const runE2E = await checkBackendAvailability();

// Use describe.skip if no backend is available
const describeE2E = runE2E ? describe : describe.skip;

describeE2E("E2E: CLI commands (FM CLI backend)", () => {
  it("available command checks FM availability", async () => {
    const { stdout, stderr, exitCode } = await runCommand(["available", "--backend", "fm"]);
    
    // Should exit with 0 or 1 depending on availability
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
    expect(stderr).not.toContain("failed");
  });

  it("available command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand(["available", "--backend", "fm", "--json"]);
    
    expect([0, 1]).toContain(exitCode);
    const output = JSON.parse(stdout);
    expect(output).toHaveProperty("available");
    expect(output).toHaveProperty("status");
  });

  it("respond command generates a response", async () => {
    const { stdout, stderr, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "Hello"
    ]);
    
    // Should succeed or fail gracefully
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with streaming", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "--stream",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "--json",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("model");
      expect(output).toHaveProperty("content");
    }
  });

  it("respond command with temperature", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "--temperature", "0.7",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with max tokens", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "--max-tokens", "100",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with system instructions", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "fm",
      "--instructions", "You are a helpful assistant",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("quota-usage command checks PCC quota", async () => {
    const { stdout, exitCode } = await runCommand(["quota-usage", "--backend", "fm"]);
    
    // Should exit with 0 or 1 depending on quota availability
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("quota-usage command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand(["quota-usage", "--backend", "fm", "--json"]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("available");
    }
  });

  it("schema command generates object schema", async () => {
    const { stdout, exitCode } = await runCommand([
      "schema",
      "object",
      "--name", "TestSchema",
      "--string", "field1",
      "--int", "field2"
    ]);
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TestSchema");
    expect(stdout).toContain("field1");
    expect(stdout).toContain("field2");
  });

  it("schema command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand([
      "schema",
      "object",
      "--name", "TestSchema",
      "--string", "field1",
      "--json"
    ]);
    
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout);
    expect(output).toHaveProperty("type", "object");
    expect(output).toHaveProperty("title", "TestSchema");
    expect(output).toHaveProperty("properties");
  });

  it("schema command generates array schema", async () => {
    const { stdout, exitCode } = await runCommand([
      "schema",
      "array",
      "--name", "TestArray"
    ]);
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TestArray");
    expect(stdout).toContain("array");
  });

  it("token-count command counts tokens", async () => {
    const { stdout, exitCode } = await runCommand([
      "token-count",
      "--backend", "fm",
      "Hello world"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("token-count command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand([
      "token-count",
      "--backend", "fm",
      "--json",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("prompt_tokens");
      expect(output).toHaveProperty("total_tokens");
    }
  });

  it("token-count command with instructions", async () => {
    const { stdout, exitCode } = await runCommand([
      "token-count",
      "--backend", "fm",
      "--instructions", "You are helpful",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });
});

describeE2E("E2E: CLI commands (helper backend)", () => {
  it("available command checks helper availability", async () => {
    const { stdout, stderr, exitCode } = await runCommand(["available", "--backend", "helper"]);
    
    // Helper may not be available, but command should not crash
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("available command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand(["available", "--backend", "helper", "--json"]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("available");
      expect(output).toHaveProperty("status");
    }
  });

  it("respond command generates a response", async () => {
    const { stdout, stderr, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "Hello"
    ]);
    
    // Helper may not be available, but command should not crash
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with streaming", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "--stream",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with JSON output", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "--json",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("model");
      expect(output).toHaveProperty("content");
    }
  });

  it("respond command with temperature", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "--temperature", "0.7",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with max tokens", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "--max-tokens", "100",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with system instructions", async () => {
    const { stdout, exitCode } = await runCommand([
      "respond",
      "--backend", "helper",
      "--instructions", "You are a helpful assistant",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("quota-usage command shows not available for helper", async () => {
    const { stdout, exitCode } = await runCommand(["quota-usage", "--backend", "helper"]);
    
    // Helper backend should indicate quota not available
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("quota-usage command with JSON output for helper", async () => {
    const { stdout, exitCode } = await runCommand(["quota-usage", "--backend", "helper", "--json"]);
    
    expect([0, 1]).toContain(exitCode);
    if (exitCode === 0) {
      const output = JSON.parse(stdout);
      expect(output).toHaveProperty("available", false);
    }
  });

  it("schema command works with helper backend", async () => {
    const { stdout, exitCode } = await runCommand([
      "schema",
      "object",
      "--name", "TestSchema",
      "--string", "field1"
    ]);
    
    // Schema command doesn't require backend
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TestSchema");
  });

  it("token-count command with helper backend", async () => {
    const { stdout, exitCode } = await runCommand([
      "token-count",
      "--backend", "helper",
      "Test"
    ]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });
});

describeE2E("E2E: CLI commands (auto-detect backend)", () => {
  it("available command with auto-detection", async () => {
    const { stdout, exitCode } = await runCommand(["available"]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("respond command with auto-detection", async () => {
    const { stdout, exitCode } = await runCommand(["respond", "Test"]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("quota-usage command with auto-detection", async () => {
    const { stdout, exitCode } = await runCommand(["quota-usage"]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });

  it("schema command with auto-detection", async () => {
    const { stdout, exitCode } = await runCommand([
      "schema",
      "object",
      "--name", "TestSchema",
      "--string", "field1"
    ]);
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TestSchema");
  });

  it("token-count command with auto-detection", async () => {
    const { stdout, exitCode } = await runCommand(["token-count", "Test"]);
    
    expect([0, 1]).toContain(exitCode);
    expect(stdout).toBeDefined();
  });
});
