// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { makeClient } from "../../lib/client";
import { SessionProvider } from "../../shell/session";
import { bodyOf, calls, list, show, Status, stubApi } from "../audience/stub";
import { inviteUser, Team, teamAccess, type TeamPerson } from "./Team";

const now = "2026-09-30T00:00:00.000Z";

function api() {
  return stubApi({
    "GET /memberships": list([{ id: "member_1", user_id: "user_ada", email: "ada@example.com", name: "Ada", role_id: "role_admin", role: "admin", created_at: now }]),
    "GET /users": list([{ id: "user_ada", email: "ada@example.com", name: "Ada", created_at: now, deactivated_at: null,
      membership_id: "member_1", membership_created_at: now, role_id: "role_admin", role: "admin", role_deleted_at: null, permissions: ["full"] }]),
    "GET /roles": list([
      { id: "role_admin", name: "Admin", permissions: ["full"], created_at: now },
      { id: "role_viewer", name: "Viewer", permissions: ["read"], created_at: now },
    ]),
    "GET /sessions": list([
      { id: "sess_1", user_id: "user_ada", email: "ada@example.com", expires_at: now, created_at: now, revoked_at: null },
      { id: "sess_2", user_id: "user_ada", email: "ada@example.com", expires_at: now, created_at: now, revoked_at: null },
    ]),
    "GET /audit-logs": list([
      { id: "audit_1", request_id: "req_1", actor_email: null, action: "domain.create", target_type: "domain", target_id: "dom_1", data: { name: "acme.com" }, created_at: now },
    ]),
    "POST /users": { object: "user", id: "user_bob", email: "bob@example.com", name: "Bob", created_at: now },
    "POST /roles": { object: "role", id: "role_support", name: "Support", permissions: ["read"] },
    "POST /memberships": { object: "membership", id: "member_2" },
    "PATCH /users/user_ada": { object: "user", id: "user_ada", email: "ada@example.com", name: "Ada", created_at: now },
    "DELETE /sessions/sess_2": { object: "session", id: "sess_2", deleted: true },
    "DELETE /memberships/member_1": { object: "membership", id: "member_1", deleted: true },
  });
}

describe("Team", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("loads one people list with roles and visible activity", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    await screen.findByText("domain.create");
    expect(calls(fetch)).toEqual(
      expect.arrayContaining([
        "GET /users?limit=20",
        "GET /roles?limit=20",
        "GET /sessions?limit=20",
        "GET /audit-logs?limit=20",
      ]),
    );
    expect(calls(fetch)).not.toContain("GET /memberships?limit=20");
    expect(screen.getByText("sess_1 (this one)").closest("details")).toBeNull();
    expect(screen.getByRole("heading", { name: "Team" }).closest("section")?.classList.contains("panel")).toBe(false);
    expect(screen.getByText("domain.create").closest("details")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Users" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Roles" })).toBeNull();
  });

  it("filters the audit log by action from the URL and opens an entry", async () => {
    const fetch = api();
    show(h(Team), "/settings/team?action=domain");
    await screen.findByText("domain.create");
    expect(calls(fetch)).toContain("GET /audit-logs?action=domain&limit=20");
    fireEvent.click(screen.getByText("domain.create"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("dom_1")).toBeTruthy();
    expect(within(drawer).getByText(/acme\.com/)).toBeTruthy();
  });

  it("invites a viewer with a first password: creates the user, then the membership", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    await screen.findByText("domain.create");
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "bob@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Bob" } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "short" } });
    expect(within(dialog).getByText("Use at least 12 characters.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "a long first password" } });
    await waitFor(() => expect(dialog.querySelector('option[value="role_viewer"]')).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Role" }));
    fireEvent.click(screen.getByRole("option", { name: "Viewer" }));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /memberships"));
    expect(bodyOf(fetch, "POST /users")).toEqual({ email: "bob@example.com", name: "Bob", password: "a long first password" });
    expect(bodyOf(fetch, "POST /memberships")).toEqual({ user_id: "user_bob", role_id: "role_viewer" });
  });

  it("sets a new password for a teammate", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    await screen.findByText("domain.create");
    const row = screen.getAllByText("ada@example.com").map((cell) => cell.closest("tr")!).find((tr) => within(tr).queryByText("Active"))!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set password" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New password"), { target: { value: "a brand new password" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("PATCH /users/user_ada"));
    expect(bodyOf(fetch, "PATCH /users/user_ada")).toEqual({ password: "a brand new password" });
  });

  it("shows a viewer the team with roles and no way to change it", async () => {
    api();
    signIn("sess_test", ["read"]);
    render(h(MemoryRouter, { initialEntries: ["/settings/team"] }, h(SessionProvider, null, h(Team))));
    await screen.findByText("domain.create");
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add role" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it("invites a removed member again: finds the user that already exists", async () => {
    const fetch = stubApi({
      "POST /users": new Status(409, { name: "validation_error", statusCode: 409, message: "A user with this email already exists" }),
      "GET /users": list([{ id: "user_ada", email: "Ada@Example.com", name: "Ada", created_at: now, deactivated_at: null }]),
      "GET /memberships": list([]),
      "POST /memberships": { object: "membership", id: "member_2" },
      "PATCH /users/user_ada": { object: "user", id: "user_ada" },
    });
    const client = makeClient({ apiUrl: "http://localhost:3100" });
    expect((await inviteUser(client, "ada@example.com", "Ada", "a long first password")).id).toBe("user_ada");
    // The password typed in the invite becomes theirs.
    expect(calls(fetch)).toEqual(["POST /users", "GET /users?limit=100", "GET /memberships?limit=100", "PATCH /users/user_ada"]);
  });

  it("will not replace a current teammate's password through an invite", async () => {
    const fetch = stubApi({
      "POST /users": new Status(409, { name: "validation_error", statusCode: 409, message: "A user with this email already exists" }),
      "GET /users": list([{ id: "user_ada", email: "ada@example.com", name: "Ada", created_at: now, deactivated_at: null }]),
      "GET /memberships": list([{ id: "member_1", user_id: "user_ada", email: "ada@example.com", name: "Ada", role_id: "role_admin", role: "Admin", created_at: now }]),
    });
    await expect(inviteUser(makeClient({ apiUrl: "http://localhost:3100" }), "ada@example.com", "Ada", "a long first password")).rejects.toThrow(/already on the team/);
    expect(calls(fetch)).not.toContain("PATCH /users/user_ada");
  });

  it("says so when the existing user is deactivated", async () => {
    stubApi({
      "POST /users": new Status(409, { name: "validation_error", statusCode: 409, message: "A user with this email already exists" }),
      "GET /users": list([{ id: "user_ada", email: "ada@example.com", name: "Ada", created_at: now, deactivated_at: now }]),
    });
    await expect(inviteUser(makeClient({ apiUrl: "http://localhost:3100" }), "ada@example.com", "Ada", "a long first password")).rejects.toThrow(/deactivated/);
  });

  it("revokes another session after typing REVOKE", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    const row = (await screen.findByText("sess_2")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "REVOKE" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /sessions/sess_2"));
  });
  it("manages roles separately and only offers supported permissions", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    fireEvent.click(screen.getByRole("button", { name: "Manage roles" }));
    const roles = await screen.findByRole("dialog", { name: "Manage roles" });
    await within(roles).findByText("Admin");
    fireEvent.click(within(roles).getByRole("button", { name: "Add role" }));
    const add = await screen.findByRole("dialog", { name: "Add role" });
    fireEvent.change(within(add).getByLabelText("Name"), { target: { value: "Support" } });
    fireEvent.click(within(add).getByRole("combobox", { name: "Permissions" }));
    fireEvent.click(screen.getByRole("option", { name: "Read only" }));
    fireEvent.submit(add.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "POST /roles")).toEqual({ name: "Support", permissions: ["read"] }));
  });

  it("retries failed role choices without discarding the new member", async () => {
    const fetch = api();
    const original = fetch.getMockImplementation()!;
    let failed = true;
    fetch.mockImplementation(async (...args) => {
      if (String(args[0]).includes("/roles") && failed) return new Response(JSON.stringify({ message: "Roles unavailable" }), { status: 500 });
      return original(...args);
    });
    show(h(Team), "/settings/team");
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Bob" } });
    await within(dialog).findByRole("button", { name: "Retry roles" });
    failed = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry roles" }));
    await waitFor(() => expect(dialog.querySelector('option[value="role_viewer"]')).toBeTruthy());
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Bob");
  });

  it("keeps team removal distinct from account deactivation", async () => {
    const fetch = api();
    show(h(Team), "/settings/team");
    const row = (await screen.findByText("admin")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Deactivate account" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from team" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "ada@example.com" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /memberships/member_1"));
    expect(calls(fetch)).not.toContain("DELETE /users/user_ada");
  });

  it("restores a removed account without creating or resetting its user", async () => {
    const fetch = api();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => {
      if (String(args[0]).includes("/users") && (!args[1]?.method || args[1]?.method === "GET")) return new Response(JSON.stringify(list([
        { id: "user_ada", email: "ada@example.com", name: "Ada", created_at: now, deactivated_at: null,
          membership_id: null, membership_created_at: null, role_id: null, role: null, role_deleted_at: null, permissions: null },
      ])));
      return original(...args);
    });
    show(h(Team), "/settings/team");
    const row = (await screen.findByText("No team access")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore team access" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector('option[value="role_viewer"]')).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Role" }));
    fireEvent.click(screen.getByRole("option", { name: "Viewer" }));
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /memberships"));
    expect(bodyOf(fetch, "POST /memberships")).toEqual({ user_id: "user_ada", role_id: "role_viewer" });
    expect(calls(fetch)).not.toContain("POST /users");
    expect(calls(fetch)).not.toContain("PATCH /users/user_ada");
  });

  it("shows actual access for removed, deactivated, and deleted-role accounts", () => {
    const person: TeamPerson = { id: "u", email: "a@b.com", name: "A", created_at: now,
      membership_id: "m", membership_created_at: now, role_id: "r", role: "Viewer", role_deleted_at: null, permissions: ["read"] };
    expect(teamAccess(person)).toBe("Enabled");
    expect(teamAccess({ ...person, membership_id: null })).toBe("No team access");
    expect(teamAccess({ ...person, deactivated_at: now })).toBe("Account deactivated");
    expect(teamAccess({ ...person, role_deleted_at: now })).toBe("Role deleted");
    expect(teamAccess({ ...person, permissions: ["unsupported"] })).toBe("No permissions");
  });

});
