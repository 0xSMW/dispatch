import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { Command } from "@commander-js/extra-typings";
import { verifyWebhook } from "@dispatchmail/sdk";
import pc from "picocolors";
import { guard, type Flags } from "../../lib/actions.js";
import { requireClient, unwrap, type Api } from "../../lib/client.js";
import { isLocal, resolve } from "../../lib/config.js";
import { CliError } from "../../lib/errors.js";
import { helpText } from "../../lib/help.js";
import { csv } from "../../lib/json.js";
import { status } from "../../lib/output.js";
import { safe } from "../../lib/safe.js";
import { jsonMode } from "../../lib/tty.js";

const hopByHop = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

// Headers to pass to the forward target untouched, so it can verify real signatures.
export function passthrough(headers: IncomingHttpHeaders) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || hopByHop.has(key)) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

// POST the raw body to the target. Its status goes back to Dispatch: 502 when
// it cannot be reached and 504 when it times out, so retries react to the local app.
export async function forward(url: string, body: Buffer, headers: Record<string, string>, timeout = 10_000) {
  try {
    const response = await fetch(url, { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(timeout) });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") return { status: 504, body: "Forward target timed out" };
    return { status: 502, body: "Forward target unreachable" };
  }
}

type Payload = { type?: string; created_at?: string; data?: Record<string, unknown> };

function resourceId(payload: Payload) {
  const data = payload.data ?? {};
  return (data.email_id ?? data.id ?? data.contact_id ?? data.broadcast_id ?? null) as string | null;
}

export const maxBody = 1024 * 1024;

type ListenerOptions = {
  forwardTo?: string;
  timeout?: number;
  globals: Flags;
  // False when the request does not carry a valid signature for the temporary webhook.
  verify?: (payload: string, headers: IncomingHttpHeaders) => boolean;
};

const reply = (response: Parameters<RequestListener>[1], code: number, message: string) => {
  if (!response.headersSent) response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
};

// A request that fails here must not take the process down: the temporary webhook is only
// deleted on the way out through a signal handler.
export function listener(options: ListenerOptions): RequestListener {
  return async (request, response) => {
    try {
      await receive(request, response, options);
    } catch {
      reply(response, 400, "Could not read the request");
    }
  };
}

async function receive(request: Parameters<RequestListener>[0], response: Parameters<RequestListener>[1], options: ListenerOptions) {
  {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBody) {
        reply(response, 413, "Body is over 1 MB");
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    // Anything that can reach this port, or the public tunnel, can post here. Only requests
    // signed with the temporary webhook's secret are shown and forwarded.
    if (options.verify && !options.verify(raw.toString("utf8"), request.headers)) {
      status(pc.yellow("Rejected a request without a valid signature"), options.globals);
      reply(response, 401, "Invalid signature");
      return;
    }
    let payload: Payload = {};
    try {
      payload = JSON.parse(raw.toString("utf8") || "{}") as Payload;
    } catch {
      payload = {};
    }
    const forwarded = options.forwardTo ? await forward(options.forwardTo, raw, passthrough(request.headers), options.timeout) : undefined;
    const line = {
      timestamp: new Date().toISOString(),
      type: payload.type ?? "unknown",
      resource_id: resourceId(payload),
      payload,
      forwarded: forwarded ? { url: options.forwardTo, status: forwarded.status } : null,
    };
    if (jsonMode(options.globals)) console.log(JSON.stringify(line));
    else {
      const sent = forwarded ? `  ${forwarded.status < 300 ? pc.green(`→ ${forwarded.status}`) : pc.red(`→ ${forwarded.status}`)}` : "";
      console.log(`${pc.dim(line.timestamp)}  ${pc.bold(safe(line.type))}  ${safe(line.resource_id ?? "")}${sent}`);
    }
    response.writeHead(forwarded?.status ?? 200, { "content-type": "application/json" });
    response.end(forwarded ? forwarded.body : JSON.stringify({ ok: true }));
  }
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export function signed(secret: string, payload: string, headers: IncomingHttpHeaders) {
  try {
    verifyWebhook({
      payload,
      headers: { id: one(headers["webhook-id"]), timestamp: one(headers["webhook-timestamp"]), signature: one(headers["webhook-signature"]) },
      webhookSecret: secret,
    });
    return true;
  } catch {
    return false;
  }
}

// Delete the temporary webhook and say so when that fails, since a leftover one keeps
// posting every event to the URL it was given.
export async function unregister(api: Api, id: string) {
  try {
    await unwrap(api.webhooks.remove(id));
  } catch {
    console.error(`Could not delete webhook ${id}. Delete it with: dispatch webhooks delete ${id}`);
  }
}

function listen(server: Server, port: number) {
  return new Promise<number>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      done(typeof address === "object" && address ? address.port : port);
    });
  });
}

export async function register(api: Api, endpoint: string, events: string[]) {
  return unwrap<{ id: string; signing_secret?: string }>(api.webhooks.create({ endpoint, events }));
}

export const listenCommand = new Command("listen")
  .description("Receive webhook events locally, and optionally forward them to your app")
  .option("--port <port>", "Local port", "4318")
  .option("--url <public-url>", "Public URL that reaches this port. Required when the API is not local")
  .option("--forward-to <url>", "POST each event to this URL with its signature headers")
  .option("--events <types>", 'Comma-separated event types, or "all"', "all")
  .addHelpText(
    "after",
    helpText({
      output: "One line per event on a terminal. NDJSON when piped: {timestamp, type, resource_id, payload, forwarded}.",
      codes: ["missing_url", "listen_error"],
      examples: [
        "dispatch webhooks listen",
        "dispatch webhooks listen --forward-to http://localhost:3000/api/webhooks",
        "dispatch webhooks listen --url https://abc.ngrok.app --forward-to http://localhost:3000/hooks",
      ],
    }),
  )
  .action(async (options, command) => {
    await guard(command, "listen_error", async (globals) => {
      const { apiUrl } = resolve(globals);
      if (!isLocal(apiUrl) && !options.url) {
        throw new CliError(
          "missing_url",
          "The API is not local, so it cannot reach this machine. Pass --url with a public URL that forwards to this port",
        );
      }
      const api = requireClient(globals);
      let hook: { id: string; signing_secret?: string } | undefined;
      const server = createServer(
        listener({
          forwardTo: options.forwardTo,
          globals,
          verify: (payload, headers) => !hook?.signing_secret || signed(hook.signing_secret, payload, headers),
        }),
      );
      const port = await listen(server, Number(options.port));
      const endpoint = options.url ?? `http://127.0.0.1:${port}`;
      // The handlers go in before the webhook exists. A stop that arrives while it is being
      // created is honored as soon as its ID is known. A closed terminal sends SIGHUP.
      let closing = false;
      let requested = false;
      const stop = async () => {
        requested = true;
        if (closing || !hook) return;
        closing = true;
        server.close();
        await unregister(api, hook.id);
        process.exit(130);
      };
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());
      hook = await register(api, endpoint, csv(options.events) ?? ["all"]);
      if (requested) return void (await stop());
      status(`${pc.green("✓")} Listening on http://127.0.0.1:${port} as webhook ${hook.id}`, globals);
      if (hook.signing_secret) status(`Signing secret: ${hook.signing_secret}`, globals);
      if (options.forwardTo) status(`Forwarding to ${options.forwardTo}`, globals);
      status(pc.dim("Press Ctrl+C to stop and delete the temporary webhook."), globals);
    });
  });
