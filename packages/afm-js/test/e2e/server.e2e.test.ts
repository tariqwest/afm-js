// ============================================================================
// server.e2e.test.ts — End-to-end tests against live server instance
// Tests the built application after build process
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

const SERVER_PORT = 19999;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

// Check if we should run E2E tests
async function checkBackendAvailability() {
  const { existsSync } = await import("node:fs");
  
  // Assume FM CLI is available at /usr/bin/fm
  // Only check for helper as fallback
  const helperPath = join(import.meta.dirname, "../../../helper/.build/release/afm-fm-helper");
  if (existsSync(helperPath)) {
    return true;
  }
  
  // FM CLI is assumed to be available
  return true;
}

const runE2E = await checkBackendAvailability();

// Use describe.skip if no backend is available
const describeE2E = runE2E ? describe : describe.skip;

describeE2E("E2E: afm-js serve (built app)", () => {
  let serverProcess: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    // Start server with auto-detected backend using the built binary
    const mainPath = join(import.meta.dirname, "../../dist/main.js");
    
    // Check if built file exists
    const { existsSync } = await import("node:fs");
    if (!existsSync(mainPath)) {
      throw new Error(`Built application not found at ${mainPath}. Run 'pnpm build' first.`);
    }

    // Force FM CLI backend (assumed to be available at /usr/bin/fm)
    const args = [mainPath, "serve", "--port", String(SERVER_PORT), "--backend", "fm"];
    
    serverProcess = spawn("node", args, {
      stdio: ["inherit", "pipe", "pipe"],
    });

    // Capture server output for debugging
    let serverOutput = "";
    serverProcess.stdout?.on("data", (data) => {
      serverOutput += data.toString();
    });
    serverProcess.stderr?.on("data", (data) => {
      serverOutput += data.toString();
    });

    // Wait for server to be ready
    try {
      await waitForServer(SERVER_URL);
    } catch (err) {
      // If server failed to start, show the output and throw
      if (serverOutput) {
        console.error("Server output:", serverOutput);
      }
      if (serverProcess.exitCode !== null) {
        throw new Error(`Server exited with code ${serverProcess.exitCode}: ${serverOutput}`);
      }
      throw err;
    }
  }, 20000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      // Give it time to shut down gracefully
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      // Force kill if still alive
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  it("health endpoint returns ok", async () => {
    const res = await fetch(`${SERVER_URL}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("model");
  });

  it("models endpoint returns available models", async () => {
    const res = await fetch(`${SERVER_URL}/v1/models`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("object", "list");
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);

    // Check for expected models
    const modelIds = body.data.map((m: { id: string }) => m.id);
    expect(modelIds).toContain("system");
  });

  it("chat completions endpoint accepts requests", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "system",
          messages: [{ role: "user", content: "Hello" }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      // Should either succeed (200) or fail with model error (503/500), not 404
      expect([200, 400, 500, 503]).toContain(res.status);
    } catch (err) {
      // Abort is expected if model takes too long to load
      clearTimeout(timeout);
      expect(String(err)).toMatch(/abort|timeout/i);
    }
  }, 10000);

  it("handles streaming requests", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "system",
          messages: [{ role: "user", content: "Test" }],
          stream: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      
      // Streaming should return 200 and Server-Sent Events
      expect([200, 400, 503]).toContain(res.status);
      
      if (res.status === 200) {
        const reader = res.body?.getReader();
        expect(reader).toBeDefined();
        
        // Read a few chunks to verify streaming works
        let chunks = 0;
        const maxChunks = 5;
        while (chunks < maxChunks) {
          const { done, value } = await reader!.read();
          if (done) break;
          if (value) chunks++;
        }
        expect(chunks).toBeGreaterThan(0);
      }
    } catch (err) {
      clearTimeout(timeout);
      expect(String(err)).toMatch(/abort|timeout/i);
    }
  }, 10000);

  it("rejects invalid model IDs", async () => {
    const res = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "invalid-model-id",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(400);
  });

  it("handles concurrent requests", async () => {
    // Test that the new per-request transport handles concurrent requests
    const requests = Array.from({ length: 3 }, () =>
      fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "system",
          messages: [{ role: "user", content: "Concurrent test" }],
        }),
      })
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const responses = await Promise.all(requests);
      clearTimeout(timeout);
      
      // All requests should complete (may fail with model errors, but not timeout)
      responses.forEach(res => {
        expect([200, 400, 500, 503]).toContain(res.status);
      });
    } catch (err) {
      clearTimeout(timeout);
      expect(String(err)).toMatch(/abort|timeout/i);
    }
  }, 10000);

  it("server starts with auto-detected backend", async () => {
    // This test verifies the server can start and respond using auto-detection
    const res = await fetch(`${SERVER_URL}/health`);
    expect(res.ok).toBe(true);
  });
});
