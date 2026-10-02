// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, list, requests, visit } from "../emails/visit";
import { Key } from "./Key";
import { keyTone, Keys } from "./Keys";

const now = Date.parse("2026-10-01T12:00:00.000Z");
const keys = [
  { id: "key_1", name: "Production", created_at: "2026-09-01T00:00:00.000Z", last_used_at: "2026-09-30T00:00:00.000Z" },
  { id: "key_2", name: "Old", created_at: "2026-06-01T00:00:00.000Z", last_used_at: "2026-07-01T00:00:00.000Z" },
  { id: "key_3", name: "Unused", created_at: "2026-09-01T00:00:00.000Z", last_used_at: null },
];

describe("Keys", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists keys and shows Never for an unused one", async () => {
    api({ "/api-keys": list(keys) });
    visit(h(Keys), "/api-keys");
    expect(await screen.findByText("Production")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
  });

  it("shows the masked token and the permission on each row", async () => {
    api({ "/api-keys": list([{ ...keys[0], token: "re_abc...", permission: "sending_access", domain_id: "domain_1" }]) });
    visit(h(Keys), "/api-keys");
    const row = (await screen.findByText("Production")).closest("tr")!;
    expect(within(row).getByText("re_abc...")).toBeTruthy();
    expect(within(row).getByText("Sending access")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Token" })).toBeTruthy();
  });

  it("colors the lock tile by last use", () => {
    expect(keys.map((key) => keyTone(key, now))).toEqual(["success", "warning", "neutral"]);
  });

  it("creates a sending key limited to a domain and shows the token once", async () => {
    const fetch = api({
      "/api-keys": list([]),
      "/domains": list([{ id: "domain_1", name: "send.acme.test" }]),
      "POST /api-keys": { object: "api_key", id: "key_9", token: "re_secret_token" },
    });
    visit(h(Keys), "/api-keys");
    await screen.findByText("No API keys");

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mailer" } });
    fireEvent.change(screen.getByLabelText("Permission"), { target: { value: "sending_access" } });
    await screen.findByRole("option", { name: "send.acme.test" });
    fireEvent.change(screen.getByLabelText("Domain"), { target: { value: "domain_1" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Create/ }));

    expect(await screen.findByText("re_secret_token")).toBeTruthy();
    expect(requests(fetch, "POST", "/api-keys")[0].body).toEqual({ name: "Mailer", permission: "sending_access", domain_id: "domain_1" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("re_secret_token")).toBeNull();
  });

  it("renames a key from the row menu", async () => {
    const fetch = api({ "/api-keys": list(keys), "PATCH /api-keys/key_1": { object: "api_key", id: "key_1" } });
    visit(h(Keys), "/api-keys");
    await screen.findByText("Production");
    fireEvent.click(screen.getAllByRole("button", { name: "Actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Production EU" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(requests(fetch, "PATCH", "/api-keys/key_1")[0]?.body).toEqual({ name: "Production EU" }));
  });

  it("removes a key after typing its name", async () => {
    const fetch = api({ "/api-keys": list(keys), "DELETE /api-keys/key_3": { object: "api_key", id: "key_3", deleted: true } });
    visit(h(Keys), "/api-keys");
    await screen.findByText("Unused");
    fireEvent.click(screen.getAllByRole("button", { name: "Actions" })[2]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "Unused" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove key/ }));
    await waitFor(() => expect(requests(fetch, "DELETE", "/api-keys/key_3")).toHaveLength(1));
  });
});

describe("Key", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows token, permission, domain, and total uses linked to filtered logs", async () => {
    const fetch = api({
      "/api-keys/key_1": {
        object: "api_key",
        id: "key_1",
        name: "Mailer",
        token: "re_abc...",
        permission: "sending_access",
        domain_id: "domain_1",
        total_uses: 1234,
        last_used_at: "2026-09-30T00:00:00.000Z",
        created_at: "2026-09-01T00:00:00.000Z",
        created_by: "user_ada",
        creator: "ada@acme.test",
      },
      "/domains/domain_1": { id: "domain_1", name: "send.acme.test" },
    });
    visit(h(Key), "/api-keys/key_1", "/api-keys/:id");

    expect(await screen.findByRole("heading", { name: "Mailer" })).toBeTruthy();
    // The person who made the key in the dashboard.
    expect(screen.getByText("ada@acme.test")).toBeTruthy();
    expect(screen.getByText("re_abc...")).toBeTruthy();
    expect(screen.getByText("Sending access")).toBeTruthy();
    expect((await screen.findByRole("link", { name: "send.acme.test" })).getAttribute("href")).toBe("/domains/domain_1");
    expect(screen.getByRole("link", { name: (1234).toLocaleString() }).getAttribute("href")).toBe("/logs?api_key_id=key_1");
    expect(requests(fetch, "GET", "/domains/domain_1")).toHaveLength(1);
  });

  it("shows All domains for a key without a domain and skips the domain request", async () => {
    const fetch = api({
      "/api-keys/key_2": {
        object: "api_key",
        id: "key_2",
        name: "Admin",
        token: "re_xyz...",
        permission: "full_access",
        domain_id: null,
        total_uses: 0,
        last_used_at: null,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    });
    visit(h(Key), "/api-keys/key_2", "/api-keys/:id");
    expect(await screen.findByText("All domains")).toBeTruthy();
    expect(screen.getByText("Full access")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/domains/"))).toBe(false);
  });
});
