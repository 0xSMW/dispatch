import { defineConfig } from "nitro/config";
import workflow from "workflow/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [workflow],
  vercel: {
    entryFormat: "node",
    config: {
      routes: [
        { src: "/api(?:/.*)?", dest: "/__server" },
        {
          src: "/\\.well-known/workflow/v1/flow",
          dest: "/.well-known/workflow/v1/flow",
        },
        {
          src: "/\\.well-known/workflow/v1/webhook/(?<token>[^/]+)",
          dest: "/.well-known/workflow/v1/webhook/[token]",
        },
        { src: "/\\.well-known/workflow/.*", dest: "/__server" },
        {
          src: "/(.*)",
          headers: {
            "Content-Security-Policy": "frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          },
          continue: true,
        },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
  },
  publicAssets: [{ dir: "../dashboard/dist", baseURL: "/" }],
  routes: { "/api/**": { handler: "./src/handler.ts", format: "node" } },
});
