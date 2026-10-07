import { describe, expect, it } from "vitest";
import { mapClerk } from "./clerk.js";

const user = {
  id: "user_synthetic", primary_email_address_id: "email_primary",
  email_addresses: [
    { id: "email_other", email_address: "secondary@example.com" },
    { id: "email_primary", email_address: " Ada@Example.com " }
  ],
  first_name: "Ada", last_name: "Lovelace"
};

describe("Clerk mapping", () => {
  it.each(["user.created", "user.updated"])("maps %s from the primary, not first email", (type) => {
    const result = mapClerk({ type, data: user });
    expect(result).toEqual({
      action: "upsert", lookup: { email: "ada@example.com" },
      contact: { first_name: "Ada", last_name: "Lovelace", properties: { clerk_user_id: "user_synthetic" } },
      event: {
        name: `clerk.${type}`,
        data: {
          user_id: "user_synthetic", email: "ada@example.com", first_name: "Ada", last_name: "Lovelace",
          properties: { clerk_user_id: "user_synthetic" }
        }
      }
    });
  });

  it("preserves null names as explicit patches without changing consent", () => {
    const result = mapClerk({ type: "user.updated", data: { ...user, first_name: null, last_name: null } });
    expect(result.action).toBe("upsert");
    if (result.action === "upsert") expect(result.contact).toEqual({
      first_name: null, last_name: null, properties: { clerk_user_id: user.id }
    });
  });

  it("does not choose a secondary email when the primary is absent or invalid", () => {
    for (const data of [
      { ...user, primary_email_address_id: null },
      { ...user, primary_email_address_id: "missing" },
      { ...user, email_addresses: [] },
      { ...user, email_addresses: [{ id: "email_primary", email_address: "invalid" }] }
    ]) expect(mapClerk({ type: "user.created", data })).toEqual({ action: "ignored", reason: "no_contact" });
  });

  it("retains a deleted user's contact by property lookup without an upsert", () => {
    expect(mapClerk({ type: "user.deleted", data: { id: user.id, deleted: true } })).toEqual({
      action: "retain", lookup: { property: "clerk_user_id", value: user.id },
      event: { name: "clerk.user.deleted", data: { user_id: user.id } }
    });
    expect(mapClerk({ type: "user.deleted", data: { id: user.id } }, { deleteContact: false }).action).toBe("retain");
  });

  it("returns deletion intent only when explicitly enabled", () => {
    expect(mapClerk({ type: "user.deleted", data: { id: user.id } }, { deleteContact: true })).toEqual({
      action: "delete", lookup: { property: "clerk_user_id", value: user.id },
      event: { name: "clerk.user.deleted", data: { user_id: user.id } }
    });
    expect(mapClerk({ type: "user.created", data: user }, { deleteContact: true }).action).toBe("upsert");
  });

  it("ignores unsupported and malformed payloads", () => {
    expect(mapClerk({ type: "session.created", data: user })).toEqual({ action: "ignored", reason: "unsupported_event" });
    for (const payload of [null, [], {}, { type: "user.created" }, { type: "user.deleted", data: {} }]) {
      expect(mapClerk(payload)).toEqual({ action: "ignored", reason: "invalid_payload" });
    }
  });

  it("leaves its input untouched", () => {
    const payload = { type: "user.updated", data: structuredClone(user) };
    const before = structuredClone(payload);
    mapClerk(payload);
    expect(payload).toEqual(before);
  });
});
