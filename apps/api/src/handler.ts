import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "./server.js";

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  await app.ready();
  // Nitro preserves the public prefix; Fastify owns conventional root API routes.
  if (request.url === "/api" || request.url?.startsWith("/api/")) {
    request.url = request.url.slice(4) || "/";
  } else if (request.url?.startsWith("/api?")) {
    request.url = `/${request.url.slice(4)}`;
  }
  app.server.emit("request", request, response);
}
