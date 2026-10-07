import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, tools, type ToolClient } from "./tools.js";

export { callTool, tools, type ToolClient } from "./tools.js";

export function config(env: Record<string, string | undefined>, args: readonly string[] = []) {
  if (args.some((arg) => arg !== "--read-only")) throw new Error("Unsupported argument");
  const apiKey = env.DISPATCH_API_KEY;
  const baseUrl = env.DISPATCH_API_URL ?? "http://localhost:3100";
  if (!apiKey?.trim()) throw new Error("DISPATCH_API_KEY is required");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("DISPATCH_API_URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  return { apiKey, baseUrl, readOnly: args.includes("--read-only") };
}

export function createServer(client: ToolClient, readOnly = false): Server {
  const server = new Server(
    { name: "@dispatchmail/mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools(readOnly) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(client, request.params.name, request.params.arguments ?? {}, readOnly)
  );
  return server;
}
