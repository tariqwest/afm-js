// ============================================================================
// HTTPServer.swift — Minimal HTTP/1.1 server over a Unix domain socket.
// Uses Network.framework (macOS 12+). Handles request framing, SSE streaming,
// and per-connection concurrency via Swift structured concurrency.
// ============================================================================

import Foundation
import Network

// ─── Parsed HTTP Request ────────────────────────────────────────────────────

struct HTTPRequest {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data
}

// ─── Response helpers ───────────────────────────────────────────────────────

struct HTTPResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func json(_ value: any Encodable, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONEncoder().encode(value)) ?? Data("{\"error\":\"encode failed\"}".utf8)
        return HTTPResponse(
            status: status,
            headers: ["Content-Type": "application/json"],
            body: data
        )
    }

    static func jsonObject(_ dict: [String: Any], status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data()
        return HTTPResponse(
            status: status,
            headers: ["Content-Type": "application/json"],
            body: data
        )
    }

    static func error(_ message: String, status: Int = 500) -> HTTPResponse {
        return jsonObject(["error": ["message": message, "type": "server_error"]], status: status)
    }

    func serialized() -> Data {
        let statusLine = "HTTP/1.1 \(status) \(Self.reasonPhrase(status))\r\n"
        var headerStr = statusLine
        headerStr += "Content-Length: \(body.count)\r\n"
        headerStr += "Connection: close\r\n"
        for (k, v) in headers {
            headerStr += "\(k): \(v)\r\n"
        }
        headerStr += "\r\n"
        var out = Data(headerStr.utf8)
        out.append(body)
        return out
    }

    private static func reasonPhrase(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Unknown"
        }
    }
}

// SSE stream header (no Content-Length; connection stays open)
func sseHeaders() -> String {
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Cache-Control: no-cache\r\n" +
    "Connection: keep-alive\r\n" +
    "\r\n"
}

func sseEvent(_ data: String) -> Data {
    Data("data: \(data)\n\n".utf8)
}

func sseDone() -> Data {
    Data("data: [DONE]\n\n".utf8)
}

// ─── HTTP/1.1 Request Parser ────────────────────────────────────────────────

private enum ParseState {
    case headers
    case body(contentLength: Int)
}

final class HTTPRequestParser {
    private var buffer = Data()
    private var state: ParseState = .headers

    /// Feed incoming bytes; returns a completed request if one is ready.
    func feed(_ incoming: Data) -> HTTPRequest? {
        buffer.append(incoming)
        return tryParse()
    }

    private func tryParse() -> HTTPRequest? {
        // Find header/body separator
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else {
            return nil
        }

        let headerData = buffer[buffer.startIndex..<headerEnd.lowerBound]
        guard let headerString = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ", maxSplits: 2).map(String.init)
        guard parts.count >= 2 else { return nil }

        let method = parts[0]
        let path   = parts[1]

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key   = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let contentLength = headers["content-length"].flatMap(Int.init) ?? 0
        let bodyStart = headerEnd.upperBound
        let available = buffer.distance(from: bodyStart, to: buffer.endIndex)

        guard available >= contentLength else { return nil }

        let body = contentLength > 0 ? Data(buffer[bodyStart..<buffer.index(bodyStart, offsetBy: contentLength)]) : Data()
        buffer.removeAll()

        return HTTPRequest(method: method, path: path, headers: headers, body: body)
    }
}

// ─── Server ─────────────────────────────────────────────────────────────────

typealias RouteHandler = (HTTPRequest, NWConnection) async -> Void

@available(macOS 26.0, *)
final class HTTPServer: @unchecked Sendable {
    private let listener: NWListener
    private let routes: [(method: String, path: String, handler: RouteHandler)]
    private var isShuttingDown = false

    init(socketPath: String, routes: [(method: String, path: String, handler: RouteHandler)]) throws {
        // Remove stale socket file
        try? FileManager.default.removeItem(atPath: socketPath)

        let params = NWParameters()
        params.allowLocalEndpointReuse = true
        // Disable TLS/DTLS for plain TCP-over-socket
        params.defaultProtocolStack.applicationProtocols.insert(
            NWProtocolTCP.Options(), at: 0)

        params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)
        self.listener = try NWListener(using: params)
        self.routes = routes
    }

    func run() async throws {
        let (stream, continuation) = AsyncStream<NWConnection>.makeStream()

        listener.newConnectionHandler = { connection in
            continuation.yield(connection)
        }

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                // Signal readiness to stderr so the Node side can probe the socket
                FileHandle.standardError.write(Data("afm-fm-helper: ready\n".utf8))
            case .failed(let error):
                FileHandle.standardError.write(Data("afm-fm-helper: listener failed: \(error)\n".utf8))
            default: break
            }
        }

        listener.start(queue: .global())

        for await connection in stream {
            if isShuttingDown { break }
            Task { await self.handle(connection) }
        }
    }

    func shutdown() {
        isShuttingDown = true
        listener.cancel()
    }

    private func handle(_ connection: NWConnection) async {
        connection.start(queue: .global())

        let parser = HTTPRequestParser()
        var request: HTTPRequest?

        // Read until we have a full request
        while request == nil {
            guard let chunk = await readChunk(connection) else { break }
            request = parser.feed(chunk)
        }

        guard let req = request else {
            connection.cancel()
            return
        }

        // Dispatch to matching route
        let method = req.method.uppercased()
        let path = req.path.components(separatedBy: "?")[0]

        for route in routes where route.method == method && route.path == path {
            await route.handler(req, connection)
            return
        }

        // 404
        let resp = HTTPResponse.error("not found", status: 404)
        send(resp.serialized(), on: connection, close: true)
    }

    private func readChunk(_ connection: NWConnection) async -> Data? {
        await withCheckedContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, error in
                if let error {
                    FileHandle.standardError.write(Data("recv error: \(error)\n".utf8))
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: data)
            }
        }
    }
}

// ─── Connection write helpers ────────────────────────────────────────────────

func send(_ data: Data, on connection: NWConnection, close: Bool) {
    connection.send(content: data, completion: .contentProcessed { _ in
        if close { connection.cancel() }
    })
}
