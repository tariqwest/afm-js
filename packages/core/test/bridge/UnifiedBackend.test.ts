// ============================================================================
// UnifiedBackend.test.ts — Abstraction over FM CLI and helper backends
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { UnifiedBackend, type BackendKind } from "../../src/bridge/UnifiedBackend.js";
import { FmSocketClient } from "../../src/fm/FmSocketClient.js";
import type { HelperRequest, HelperReply, HelperStreamFrame } from "../../src/bridge/HelperProcess.js";
import { AfmError } from "../../src/errors/AfmError.js";

// Mock FmSocketClient
class MockFmSocketClient {
  private mockRequest = vi.fn();
  private mockStream = vi.fn();
  mockClose = vi.fn();

  async request(method: string, path: string, body?: unknown): Promise<{ statusCode: number; body: Buffer; headers: Map<string, string> }> {
    return this.mockRequest(method, path, body);
  }

  async *streamSSE(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, unknown> {
    yield* this.mockStream(method, path, body, headers, signal);
  }

  close(): void {
    this.mockClose();
  }

  setMockResponse(path: string, response: { statusCode: number; body: unknown }, method: string = "POST") {
    this.mockRequest.mockImplementation((reqMethod: string, reqPath: string) => {
      if (reqPath === path && reqMethod === method) {
        return Promise.resolve({
          statusCode: response.statusCode,
          body: Buffer.from(JSON.stringify(response.body)),
          headers: new Map([["content-type", "application/json"]]),
        });
      }
      throw new Error(`Unexpected request: ${reqMethod} ${reqPath}`);
    });
  }

  setMockStream(path: string, frames: unknown[]) {
    this.mockStream.mockImplementation(function* (method: string, reqPath: string) {
      if (reqPath === path && method === "POST") {
        for (const frame of frames) yield frame;
      } else {
        throw new Error(`Unexpected stream request: ${method} ${reqPath}`);
      }
    });
  }
}

describe("UnifiedBackend", () => {
  let mockClient: MockFmSocketClient;
  let backend: UnifiedBackend;

  beforeEach(() => {
    mockClient = new MockFmSocketClient();
    backend = new UnifiedBackend({
      kind: "helper",
      fmClient: mockClient as unknown as FmSocketClient,
    });
  });

  describe("backend kind", () => {
    it("returns correct kind", () => {
      expect(backend.getKind()).toBe("helper" as BackendKind);
    });
  });

  describe("call method", () => {
    it("handles availability check", async () => {
      mockClient.setMockResponse("/v1/models", {
        statusCode: 200,
        body: { data: [{ id: "system" }] },
      }, "GET");

      const reply = await backend.call({
        op: "availability",
      });

      expect(reply).toHaveProperty("status", "available");
      expect(reply).toHaveProperty("ok", true);
    });

    it("creates and stores session state", async () => {
      const reply = await backend.call({
        op: "openSession",
        backend: "on_device",
        instructions: "You are a helpful assistant",
      });

      expect(reply).toHaveProperty("session");
      expect(reply).toHaveProperty("ok", true);
      expect(typeof (reply as any).session).toBe("string");
    });

    it("uses session state for respond", async () => {
      // First open a session
      const sessionReply = await backend.call({
        op: "openSession",
        backend: "on_device",
        instructions: "Be concise",
      });
      const sessionId = (sessionReply as any).session;

      // Mock the HTTP response for respond
      mockClient.setMockResponse("/v1/chat/completions", {
        statusCode: 200,
        body: {
          choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      });

      const reply = await backend.call({
        op: "respond",
        session: sessionId,
        prompt: "Hi",
      });

      expect(reply).toHaveProperty("content", "Hello!");
      expect(reply).toHaveProperty("finishReason", "stop");
    });

    it("closes session and clears state", async () => {
      const sessionReply = await backend.call({
        op: "openSession",
        backend: "on_device",
      });
      const sessionId = (sessionReply as any).session;

      const reply = await backend.call({
        op: "closeSession",
        session: sessionId,
      });

      expect(reply).toHaveProperty("ok", true);
    });
  });

  describe("streamRequest method", () => {
    it("streams with session state", async () => {
      // Open a session first
      const sessionReply = await backend.call({
        op: "openSession",
        backend: "on_device",
        instructions: "Be helpful",
      });
      const sessionId = (sessionReply as any).session;

      // Mock streaming response
      mockClient.setMockStream("/v1/chat/completions", [
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
        { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]);

      const frames: unknown[] = [];
      for await (const frame of backend.streamRequest({
        op: "stream",
        session: sessionId,
        prompt: "Hi",
      })) {
        frames.push(frame);
      }

      expect(frames).toHaveLength(3);
      expect(frames[0]).toHaveProperty("event", "delta");
      expect(frames[2]).toHaveProperty("event", "done");
    });

    it("rejects unknown session", async () => {
      const frames: unknown[] = [];
      for await (const frame of backend.streamRequest({
        op: "stream",
        session: "unknown-session",
        prompt: "Hi",
      })) {
        frames.push(frame);
      }

      expect(frames).toHaveLength(1);
      expect(frames[0]).toHaveProperty("ok", false);
      expect(frames[0]).toHaveProperty("error.message", "Unknown session: unknown-session");
    });
  });

  describe("shutdown", () => {
    it("closes client and clears sessions", async () => {
      // Open a session first
      await backend.call({ op: "openSession", backend: "on_device" });
      
      await backend.shutdown();

      expect(mockClient.mockClose).toHaveBeenCalled();
      
      // After shutdown, calls should fail
      await expect(
        backend.call({ op: "openSession" })
      ).rejects.toThrow("shutting down");
    });
  });
});

describe("UnifiedBackend FM backend (placeholder)", () => {
  it("createFm static method exists", () => {
    // FM backend requires actual fm binary, can't test in CI
    // But we verify the method exists
    expect(typeof UnifiedBackend.createFm).toBe("function");
  });
});
