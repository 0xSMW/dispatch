// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, list, requests, visit } from "../emails/visit";
import { errorText, Log, relatedEmail } from "./Log";
import { Logs } from "./Logs";

const log = {
  object: "log",
  id: "log_1",
  created_at: "2026-09-30T10:00:00.000Z",
  endpoint: "/emails",
  method: "POST",
  response_status: 200,
  user_agent: "dispatch-node/0.1.0",
};

describe("Logs", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("maps the URL filters to the API's names", async () => {
    const fetch = api({ "/logs": list([log]), "/api-keys": list([{ id: "key_1", name: "Production", created_at: "2026-09-01T00:00:00.000Z" }]) });
    visit(h(Logs), "/logs?q=/emails&status=4xx&api_key_id=key_1&user_agent=curl&range=custom&start=2026-09-01&end=2026-09-30", "/logs");

    expect(await screen.findByText("/emails")).toBeTruthy();
    const query = requests(fetch, "GET", "/logs")[0].url.searchParams;
    expect(query.get("q")).toBe("/emails");
    expect(query.get("status")).toBe("4xx");
    expect(query.get("api_key_id")).toBe("key_1");
    expect(query.get("user_agent")).toBe("curl");
    expect(query.get("start_date")).toBe(new Date(2026, 8, 1).toISOString());
    expect(query.get("end_date")).toBe(new Date(new Date(2026, 9, 1).getTime() - 1).toISOString());
    expect(query.get("path")).toBeNull();
  });

  it("scopes the list to one email from ?email_id and can clear it", async () => {
    const fetch = api({ "/logs": list([log]), "/api-keys": list([]) });
    visit(h(Logs), "/logs?email_id=email_1", "/logs");
    expect(await screen.findByText("/emails")).toBeTruthy();
    expect(requests(fetch, "GET", "/logs")[0].url.searchParams.get("email_id")).toBe("email_1");
    expect(screen.getByRole("link", { name: "email_1" }).getAttribute("href")).toBe("/emails/email_1");
    fireEvent.click(screen.getByRole("button", { name: "Show all logs" }));
    await waitFor(() => expect(requests(fetch, "GET", "/logs")).toHaveLength(2));
    expect(requests(fetch, "GET", "/logs")[1].url.searchParams.get("email_id")).toBeNull();
  });

  it("writes the user agent filter on Enter", async () => {
    const fetch = api({ "/logs": list([log]), "/api-keys": list([]) });
    visit(h(Logs), "/logs");
    await screen.findByText("/emails");
    const input = screen.getByLabelText("User agent");
    fireEvent.change(input, { target: { value: "dispatch-cli" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(requests(fetch, "GET", "/logs").at(-1)?.url.searchParams.get("user_agent")).toBe("dispatch-cli"));
  });
});

describe("Log", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, both bodies, and a link to the email it created", async () => {
    api({
      "/logs/log_1": { ...log, request_body: { to: "ada@example.com", subject: "Hi" }, response_body: { id: "email_42" } },
    });
    visit(h(Log), "/logs/log_1", "/logs/:id");

    expect(await screen.findByText("dispatch-node/0.1.0")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View email" }).getAttribute("href")).toBe("/emails/email_42");
    expect(screen.getByText('"email_42"')).toBeTruthy();
    expect(screen.getByText('"ada@example.com"')).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts the error message in a red banner", async () => {
    api({
      "/logs/log_2": {
        ...log,
        id: "log_2",
        response_status: 422,
        request_body: { to: "nope" },
        response_body: { name: "validation_error", statusCode: 422, message: "to must be an email" },
      },
    });
    visit(h(Log), "/logs/log_2", "/logs/:id");
    expect((await screen.findByRole("alert")).textContent).toContain("to must be an email");
    expect(screen.queryByRole("link", { name: "View email" })).toBeNull();
  });

  it("finds the related email from the path or the response", () => {
    expect(relatedEmail({ endpoint: "/emails/email_7/cancel", response_body: null })).toBe("email_7");
    expect(relatedEmail({ endpoint: "/domains", response_body: { id: "domain_1" } })).toBeNull();
    expect(errorText({ response_status: 500, response_body: null })).toBe("The request failed with status 500.");
    expect(errorText({ response_status: 204, response_body: null })).toBeNull();
  });
});
