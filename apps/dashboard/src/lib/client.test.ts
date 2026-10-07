// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { callAt, mockFetch } from "../testing";
import { ApiError, makeClient, withQuery } from "./client";

const apiUrl = "http://localhost:3100";

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the call to fail");
}

describe("client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws an ApiError carrying name, statusCode, and message from the API body", async () => {
    mockFetch(() => ({
      status: 422,
      body: { name: "validation_error", statusCode: 422, message: "to is required", request_id: "req_1" },
    }));
    const error = await failure(makeClient({ apiUrl, token: "sess_x" }).post("/emails", {}));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("validation_error");
    expect(error.statusCode).toBe(422);
    expect(error.message).toBe("to is required");
    expect(error.requestId).toBe("req_1");
    expect(error.issues).toEqual([]);
  });

  it("carries schema issues with their paths into the body", async () => {
    mockFetch(() => ({
      status: 400,
      body: {
        name: "validation_error",
        statusCode: 400,
        message: "Required",
        path: "steps.1.config.template",
        issues: [
          { path: "steps.1.config.template", message: "Required" },
          { path: "name", message: "Too long" },
        ],
      },
    }));
    const error = await failure(makeClient({ apiUrl, token: "sess_x" }).patch("/automations/auto_1", {}));
    expect(error.issues).toEqual([
      { path: "steps.1.config.template", message: "Required" },
      { path: "name", message: "Too long" },
    ]);
  });

  it("falls back to application_error when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" })));
    const error = await failure(makeClient({ apiUrl }).get("/emails"));
    expect(error.name).toBe("application_error");
    expect(error.statusCode).toBe(502);
    expect(error.message).toBe("Bad Gateway");
  });

  it("reports network failures as network_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const error = await failure(makeClient({ apiUrl }).get("/emails"));
    expect(error.name).toBe("network_error");
    expect(error.statusCode).toBe(0);
  });

  it("calls unprefixed paths with a bearer token and a flat JSON body", async () => {
    const fetch = mockFetch(() => ({ body: { object: "domain", id: "domain_1" } }));
    const client = makeClient({ apiUrl, token: "sess_x" });
    const result = await client.post<{ id: string }>("/domains", { name: "example.com" });
    expect(result.id).toBe("domain_1");
    const { url, init } = callAt(fetch);
    expect(url).toBe("http://localhost:3100/domains");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sess_x");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"example.com"}');
  });

  it("sends uploads as multipart without a JSON content type", async () => {
    const fetch = mockFetch(() => ({ body: { object: "contact_import", id: "imp_1" } }));
    await makeClient({ apiUrl, token: "sess_x" }).upload("/contacts/imports", { file: new Blob(["email\n"]), segment_id: "seg_1" });
    const { init } = callAt(fetch);
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).get("content-type")).toBeNull();
    expect((init.body as FormData).get("segment_id")).toBe("seg_1");
  });

  it("signs out on a 401", async () => {
    mockFetch(() => ({ status: 401, body: { name: "invalid_api_key", statusCode: 401, message: "Expired" } }));
    const onUnauthorized = vi.fn();
    await makeClient({ apiUrl, token: "sess_x", onUnauthorized }).get("/me").catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote API URL", async () => {
    const error = await failure(makeClient({ apiUrl: "https://evil.example" }).get("/emails"));
    expect(error.name).toBe("invalid_api_url");
  });

  it("accepts the API the dashboard was built for, and still rejects any other host", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.dispatch.example");
    try {
      const { apiBase } = await import("./client");
      expect(apiBase("https://api.dispatch.example/")).toBe("https://api.dispatch.example");
      expect(() => apiBase("https://evil.example")).toThrow("API URL is not allowed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves a configured API prefix for sign-in and authenticated requests", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.dispatch.example/api");
    try {
      const fetch = mockFetch(() => ({ body: { token: "sess_x" } }));
      const client = makeClient({ apiUrl: "https://api.dispatch.example/api/" });
      await client.post("/sessions", { email: "hello@smw.ai", password: "test-password" });
      expect(callAt(fetch).url).toBe("https://api.dispatch.example/api/sessions");
      await client.get("/me");
      expect(fetch.mock.calls[1][0]).toBe("https://api.dispatch.example/api/me");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds query strings and skips empty values", () => {
    expect(withQuery("/emails", { limit: 40, status: "", q: undefined, after: "email_1" })).toBe("/emails?limit=40&after=email_1");
    expect(withQuery("/emails?limit=1", { q: "ada" })).toBe("/emails?limit=1&q=ada");
  });
});
