// ============================================================================
// FmSocketClient.test.ts — Basic tests for UDS HTTP transport
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FmSocketClient } from "../../src/fm/FmSocketClient.js";
import { createServer as createHttpServer, type Server, IncomingMessage, ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("FmSocketClient", () => {
  let server: Server;
  let socketPath: string;
  let lastRequest: { method: string; path: string; body: string } | null = null;

  beforeAll(async () => {
    socketPath = join(tmpdir(), `fm-test-${Date.now()}.sock`);
    
    server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      
      req.on("end", () => {
        lastRequest = {
          method: req.method || "GET",
          path: req.url || "/",
          body,
        };
        
        // Send HTTP response
        const responseBody = JSON.stringify({ success: true });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": responseBody.length,
        });
        res.end(responseBody);
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore
    }
  });

  it("connects to Unix socket and sends HTTP request", async () => {
    const client = new FmSocketClient(socketPath);
    await client.connect();
    
    const response = await client.request("POST", "/test", { hello: "world" });
    
    expect(response.statusCode).toBe(200);
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.path).toBe("/test");
    expect(JSON.parse(lastRequest?.body || "")).toEqual({ hello: "world" });
    
    client.close();
  });

  it("parses JSON response body", async () => {
    const client = new FmSocketClient(socketPath);
    await client.connect();
    
    const response = await client.request("GET", "/test");
    const responseBody = JSON.parse(response.body.toString("utf-8"));
    
    expect(responseBody).toEqual({ success: true });
    
    client.close();
  });
});
