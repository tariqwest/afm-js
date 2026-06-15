// ============================================================================
// FmSocketClient.ts — HTTP over Unix Domain Socket client for /usr/bin/fm
// serve --socket. Provides request/response and streaming SSE capabilities.
// ============================================================================

import { request as httpRequest, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { type HTTPResponse } from "./UDSHTTPParser.js";

export interface StreamChunk {
  data: unknown;
  done: boolean;
}

export class FmSocketClient {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath, () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HTTPResponse> {
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: {
          Host: "localhost",
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: this.normalizeHeaders(res),
            body: Buffer.concat(chunks),
          });
        });
      });

      req.on("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async *stream(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): AsyncGenerator<StreamChunk, void, unknown> {
    for await (const data of this.streamSSE(method, path, body, headers)) {
      yield { data, done: false };
    }
  }

  async *streamSSE(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, unknown> {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const response = await this.openStream(method, path, bodyStr, headers, signal);

    if ((response.statusCode ?? 0) >= 400) {
      const bodyChunks: Buffer[] = [];
      for await (const chunk of response) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      throw new Error(`HTTP ${response.statusCode ?? 0}: ${Buffer.concat(bodyChunks).toString("utf-8")}`);
    }

    let sseBuffer = "";

    try {
      for await (const chunk of response) {
        if (signal?.aborted) {
          response.destroy(new Error("Request aborted"));
          return;
        }

        sseBuffer += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString("utf-8");

        while (true) {
          const eventEnd = this.findEventBoundary(sseBuffer);
          if (eventEnd === -1) {
            break;
          }

          const event = sseBuffer.slice(0, eventEnd).replace(/\r\n/g, "\n");
          const separatorLength = this.getSeparatorLength(sseBuffer, eventEnd);
          sseBuffer = sseBuffer.slice(eventEnd + separatorLength);

          const eventData = this.parseEventData(event);
          if (eventData === "[DONE]") {
            return;
          }

          if (eventData) {
            try {
              yield JSON.parse(eventData);
            } catch (err) {
              // Ignore malformed JSON chunks - they may be partial or invalid
              // The stream will continue with the next chunk
            }
          }
        }
      }
    } finally {
      response.destroy();
    }
  }

  close(): void {
    return;
  }

  private openStream(
    method: string,
    path: string,
    body: string | undefined,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: {
          Host: "localhost",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...headers,
        },
      }, (res) => {
        resolve(res);
        // Clean up abort listener on successful response
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      });

      const onAbort = () => req.destroy(new Error("Request aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });

      req.on("error", (err) => {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      req.on("close", () => {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  private normalizeHeaders(response: IncomingMessage): Map<string, string> {
    const normalized = new Map<string, string>();
    for (const [key, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) {
        normalized.set(key.toLowerCase(), value.join(", "));
      } else if (typeof value === "string") {
        normalized.set(key.toLowerCase(), value);
      }
    }
    return normalized;
  }

  private findEventBoundary(buffer: string): number {
    const crlfBoundary = buffer.indexOf("\r\n\r\n");
    const lfBoundary = buffer.indexOf("\n\n");

    if (crlfBoundary === -1) {
      return lfBoundary;
    }
    if (lfBoundary === -1) {
      return crlfBoundary;
    }
    return Math.min(crlfBoundary, lfBoundary);
  }

  private getSeparatorLength(buffer: string, eventEnd: number): number {
    // Check which separator was actually found at eventEnd
    if (buffer.startsWith("\r\n\r\n", eventEnd)) {
      return 4;
    }
    return 2;
  }

  private parseEventData(event: string): string {
    const dataLines: string[] = [];
    for (const line of event.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    return dataLines.join("\n");
  }
}
