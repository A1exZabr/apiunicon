import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";

import { createMcpServer } from "./server.js";
import type { ToolDependencies } from "./tools.js";

// Serves one stateless Streamable HTTP request with an already assembled MCP server. A host that authenticates the
// request itself builds the server for the caller and hands it here.
export async function handleMcpRequest(mcp: McpServer, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  // The SDK declares the transport's optional handlers in a form exactOptionalPropertyTypes refuses; it is a Transport.
  await mcp.connect(transport as unknown as Transport);
  reply.hijack();
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    void mcp.close();
  };
  reply.raw.once("close", cleanup);
  try {
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch {
    cleanup();
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP error" },
        id: null,
      }));
    }
  }
}

// Whether the request carries "Authorization: Bearer <token>", compared in constant time.
function carriesToken(header: string | undefined, token: string): boolean {
  const offered = /^Bearer ([^\s]+)$/u.exec(header ?? "")?.[1];
  if (offered === undefined) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(offered), digest(token));
}

// The local endpoint. It answers only a client that sends this computer's MCP token from the state folder (see
// ensureManagedState): a page in the browser or another user's program that reaches the port has no way to it. Without
// a token it answers no one.
export function registerHttpMcpRoute(server: FastifyInstance, dependencies: ToolDependencies, token: string | undefined): void {
  server.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    bodyLimit: 2 * 1024 * 1024,
    // Checked before the body is read.
    onRequest: async (request, reply) => {
      if (token === undefined || !carriesToken(request.headers.authorization, token)) {
        return reply.code(401).header("www-authenticate", "Bearer").send({ error: "invalid_token" });
      }
    },
    // Each request gets a server of its own and none of them hears the client's initialize, so none can tell whether
    // the client draws the chat card: changes here are confirmed by link only.
    handler: async (request, reply) => handleMcpRequest(createMcpServer(dependencies, { cards: false }), request, reply),
  });
}
