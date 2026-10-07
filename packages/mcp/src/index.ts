#!/usr/bin/env node
import { Dispatch } from "@dispatchmail/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config, createServer } from "./server.js";

try {
  const options = config(process.env, process.argv.slice(2));
  const client = new Dispatch({ apiKey: options.apiKey, baseUrl: options.baseUrl });
  await createServer(client, options.readOnly).connect(new StdioServerTransport());
} catch {
  // stdout belongs exclusively to the MCP transport; never print config or errors
  // that could contain credentials.
  process.stderr.write("Dispatch MCP could not start. Check DISPATCH_API_URL, DISPATCH_API_KEY and --read-only.\n");
  process.exitCode = 1;
}
