// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { calls, show, Status, stubApi } from "../audience/stub";
import { relay, Smtp, smtpHost } from "./Smtp";

const system = (smtp: unknown) => ({ object: "system", ok: true, provider: "ses", worker: { backlog: {}, concurrency: 5 }, webhooks: {}, automations: {}, logs: null, smtp });

describe("Smtp", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows the host and ports from GET /system", async () => {
    const fetch = stubApi({ "GET /system": system({ host: "smtp.acme.com", port: 2587, tls_port: 2465 }) });
    show(h(Smtp), "/settings/smtp");
    expect((await screen.findAllByText("smtp.acme.com")).length).toBeGreaterThan(0);
    expect(calls(fetch)).toContain("GET /system");
    expect(screen.getByText("2587")).toBeTruthy();
    expect(screen.getByText("2465")).toBeTruthy();
    expect(screen.getByText("dispatch")).toBeTruthy();
    expect(screen.getByText(/An API key/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create one" }).getAttribute("href")).toBe("/api-keys");
    expect(screen.queryByText(/relay host is not configured/)).toBeNull();
  });

  it("falls back to the API's host name when SMTP_HOST is not set, and says so", async () => {
    stubApi({ "GET /system": system({ host: null, port: 587, tls_port: 465 }) });
    show(h(Smtp), "/settings/smtp");
    expect(await screen.findByText(/relay host is not configured/)).toBeTruthy();
    expect(screen.getAllByText("localhost").length).toBeGreaterThan(0);
    expect(screen.getByText("587")).toBeTruthy();
  });

  it("uses the default ports when /system fails", async () => {
    stubApi({ "GET /system": new Status(500, { name: "application_error", message: "Boom" }) });
    show(h(Smtp), "/settings/smtp");
    expect(await screen.findByText(/ports are the defaults/)).toBeTruthy();
    expect(screen.getByText("465")).toBeTruthy();
  });
});

describe("Smtp helpers", () => {
  it("uses the API host name", () => {
    expect(smtpHost("https://api.acme.com:3100")).toBe("api.acme.com");
    expect(smtpHost(undefined)).toBe("localhost");
    expect(smtpHost("not a url")).toBe("localhost");
  });

  it("prefers the configured host and keeps the ports", () => {
    expect(relay({ host: "smtp.acme.com", port: 25, tls_port: 465 }, "https://api.acme.com")).toEqual({ host: "smtp.acme.com", guessed: false, port: 25, tlsPort: 465 });
    expect(relay({ host: null, port: 587, tls_port: 465 }, "https://api.acme.com")).toEqual({ host: "api.acme.com", guessed: true, port: 587, tlsPort: 465 });
  });
});
