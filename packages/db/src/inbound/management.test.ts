import { encrypted } from "@dispatchmail/core";
import type { IntegrationInput, IntegrationRecord, IntegrationUpdate } from "@dispatchmail/core";
import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../index.js";
import {
  createIntegration, deleteIntegration, getIntegration, integrationByToken, integrationColumns,
  listDeliveries, presentIntegration, rotateIntegration, updateIntegration,
} from "./management.js";
import { decryptCredentials, encryptCredentials, inboundTokenHash } from "./security.js";

const appSecret = "synthetic_app_secret";
const signingSecret = "synthetic_signing_secret";
const restrictedKey = "synthetic_restricted_key";

function row(): IntegrationRecord {
  const stored = encryptCredentials({ signingSecret, stripeRestrictedKey: restrictedKey }, appSecret);
  return {
    id: "integration_test", tenant_id: "tenant_test", provider: "stripe",
    name: "Synthetic", slug: "stripe", token_hash: inboundTokenHash("synthetic_token"),
    secret: stored.signingSecret,
    settings: { map_plan: true, delete_contact: false, stripe_restricted_key: stored.stripeRestrictedKey },
    last_received_at: null, created_at: "2026-10-05", updated_at: "2026-10-05", deleted_at: null,
  };
}

function mock(...responses: unknown[][]) {
  const query = vi.fn();
  for (const rows of responses) query.mockResolvedValueOnce({ rows });
  return { client: { query } as unknown as Queryable, query };
}

const input: IntegrationInput = {
  provider: "stripe", name: "Synthetic", secret: signingSecret,
  settings: { stripe_restricted_key: restrictedKey },
};

describe("encrypted inbound management", () => {
  it("presents only public fields and reports key presence without mutation", () => {
    const current = row();
    const before = structuredClone(current);
    const result = presentIntegration({
      ...current, settings: { ...current.settings, unexpected_secret: "synthetic_extra" } as never,
    });
    expect(result).toEqual({
      object: "integration", id: current.id, provider: "stripe", name: "Synthetic", slug: "stripe",
      settings: { map_plan: true, delete_contact: false }, has_restricted_key: true,
      last_received_at: null, created_at: current.created_at, updated_at: current.updated_at,
    });
    expect(current).toEqual(before);
    expect(presentIntegration({ ...current, settings: { stripe_restricted_key: null } }).has_restricted_key).toBe(false);
    for (const value of [signingSecret, restrictedKey, current.secret, current.token_hash, "synthetic_extra"]) {
      expect(JSON.stringify(result)).not.toContain(value);
    }
  });

  it("creates a 32-byte one-time token with hash-only storage and encrypted credentials", async () => {
    const db = mock();
    db.query.mockImplementation(async (_sql: string, values: unknown[]) => ({
      rows: [{
        ...row(), id: values[0], tenant_id: values[1], provider: values[2], name: values[3],
        slug: values[4], token_hash: values[5], secret: values[6], settings: JSON.parse(values[7] as string),
      }],
    }));
    const before = structuredClone(input);
    const result = await createIntegration(db.client, "tenant_test", input, appSecret);
    const [sql, values] = db.query.mock.calls[0]!;
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(result.token, "base64url")).toHaveLength(32);
    expect(values[5]).toBe(inboundTokenHash(result.token));
    expect(values).not.toContain(result.token);
    expect(sql).toContain(`returning ${integrationColumns}`);
    const settings = JSON.parse(values[7]);
    expect(settings.delete_contact).toBe(false);
    expect(encrypted(values[6])).toBe(true);
    expect(encrypted(settings.stripe_restricted_key)).toBe(true);
    expect(decryptCredentials({
      signingSecret: values[6], stripeRestrictedKey: settings.stripe_restricted_key,
    }, appSecret)).toEqual({ signingSecret, stripeRestrictedKey: restrictedKey });
    expect(JSON.stringify(result.integration)).not.toContain(restrictedKey);
    expect(input).toEqual(before);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each(["stripe", "clerk", "supabase"] as const)("uses the named %s provider prefix", async provider => {
    const db = mock([row()]);
    await createIntegration(db.client, "tenant_test", { ...input, provider }, appSecret);
    expect(db.query.mock.calls[0]![1][4]).toBe(provider);
  });

  it.each(["stripe", "clerk", "supabase"])("rejects reserved webhook slug %s before writes", async slug => {
    const db = mock();
    await expect(createIntegration(db.client, "tenant_test", { ...input, provider: "webhook", slug }, appSecret))
      .rejects.toMatchObject({ name: "validation_error", statusCode: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
  it("defaults Standard Webhooks to the compatible webhook namespace", async () => {
    const db = mock([row()]);
    await createIntegration(db.client, "tenant_test", { ...input, provider: "webhook" }, appSecret);
    expect(db.query.mock.calls[0]![1][4]).toBe("webhook");
  });

  it("accepts an explicit custom webhook prefix and explicit deletion policy", async () => {
    const db = mock([row()]);
    await createIntegration(db.client, "tenant_test", {
      ...input, provider: "webhook", slug: "billing", settings: { delete_contact: true },
    }, appSecret);
    const values = db.query.mock.calls[0]![1];
    expect(values[4]).toBe("billing");
    expect(JSON.parse(values[7])).toEqual({ delete_contact: true });
  });

  it("rejects a named provider prefix override and immutable PATCH fields without queries", async () => {
    const db = mock();
    await expect(createIntegration(db.client, "tenant_test", { ...input, slug: "billing" }, appSecret)).rejects.toThrow();
    for (const field of ["slug", "provider"]) {
      await expect(updateIntegration(db.client, "tenant_test", "integration_test",
        { [field]: "webhook" } as IntegrationUpdate, appSecret)).rejects.toThrow();
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it("merges PATCH settings under a row lock, retaining omitted ciphertext and false values", async () => {
    const current = row();
    const db = mock([current], [current]);
    await updateIntegration(db.client, "tenant_test", current.id,
      { name: "Updated", settings: { map_plan: false, delete_contact: true } }, appSecret);
    expect(db.query.mock.calls[0]![0]).toContain("deleted_at is null for update");
    const [sql, values] = db.query.mock.calls[1]!;
    expect(values.slice(0, 4)).toEqual(["tenant_test", current.id, "Updated", current.secret]);
    expect(JSON.parse(values[4])).toEqual({ ...current.settings, map_plan: false, delete_contact: true });
    expect(sql).not.toMatch(/set.*(?:slug|provider|token_hash)\s*=/);
    expect(current.settings.map_plan).toBe(true);
  });

  it("replaces only the restricted key while retaining the signing-secret ciphertext", async () => {
    const current = row();
    const db = mock([current], [current]);
    await updateIntegration(db.client, "tenant_test", current.id,
      { settings: { stripe_restricted_key: "synthetic_new_key" } }, appSecret);
    const values = db.query.mock.calls[1]![1];
    expect(values[3]).toBe(current.secret);
    expect(decryptCredentials({
      signingSecret: values[3], stripeRestrictedKey: JSON.parse(values[4]).stripe_restricted_key,
    }, appSecret)).toEqual({ signingSecret, stripeRestrictedKey: "synthetic_new_key" });
  });

  it("replaces the signing secret, preserves an omitted key, and clears a key on explicit null", async () => {
    const current = row();
    for (const settings of [undefined, { stripe_restricted_key: null }]) {
      const db = mock([current], [current]);
      await updateIntegration(db.client, "tenant_test", current.id, { secret: "synthetic_new_secret", settings }, appSecret);
      const values = db.query.mock.calls[1]![1];
      const storedKey = JSON.parse(values[4]).stripe_restricted_key;
      expect(storedKey).toBe(settings ? null : current.settings.stripe_restricted_key);
      expect(decryptCredentials({ signingSecret: values[3] }, appSecret).signingSecret).toBe("synthetic_new_secret");
    }
    const db = mock([current], [current]);
    await updateIntegration(db.client, "tenant_test", current.id, { settings: { stripe_restricted_key: null } }, appSecret);
    expect(db.query.mock.calls[1]![1][3]).toBe(current.secret);
    expect(JSON.parse(db.query.mock.calls[1]![1][4]).stripe_restricted_key).toBeNull();
  });

  it("scopes get/delete/rotate to a tenant and live rows, without transaction control", async () => {
    const current = row();
    const db = mock([current], [{ id: current.id }], [], [current]);
    expect(await getIntegration(db.client, "tenant_test", current.id)).toEqual(presentIntegration(current));
    expect(await deleteIntegration(db.client, "tenant_test", current.id)).toBe(true);
    expect(await deleteIntegration(db.client, "tenant_test", current.id)).toBe(false);
    const rotated = await rotateIntegration(db.client, "tenant_test", current.id);
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.query.mock.calls[3]![1][2]).toBe(inboundTokenHash(rotated.token));
    for (const [sql, values] of db.query.mock.calls) {
      expect(sql).toContain("tenant_id = $1 and id = $2 and deleted_at is null");
      expect(values.slice(0, 2)).toEqual(["tenant_test", current.id]);
      expect(sql).not.toMatch(/\b(begin|commit|rollback)\b/i);
      expect(values).not.toContain(rotated.token);
    }
  });

  it("returns not-found for invisible get/update/rotate without a subsequent write", async () => {
    for (const operation of [
      (client: Queryable) => getIntegration(client, "other_tenant", "integration_test"),
      (client: Queryable) => updateIntegration(client, "other_tenant", "integration_test", {}, appSecret),
      (client: Queryable) => rotateIntegration(client, "other_tenant", "integration_test"),
    ]) {
      const db = mock([]);
      await expect(operation(db.client)).rejects.toMatchObject({ name: "not_found", statusCode: 404 });
      expect(db.query).toHaveBeenCalledTimes(1);
    }
  });

  it("looks up internal encrypted records by token hash only, excluding deleted rows", async () => {
    const current = row();
    const db = mock([current], []);
    expect(await integrationByToken(db.client, "synthetic_token")).toBe(current);
    expect(await integrationByToken(db.client, "unknown_token")).toBeNull();
    expect(await integrationByToken(db.client, "")).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0]![1]).toEqual([inboundTokenHash("synthetic_token")]);
    expect(db.query.mock.calls[0]![0]).toContain("token_hash = $1 and deleted_at is null");
  });

  it("lists body-free tenant deliveries with default 20, max 100 and deterministic ordering", async () => {
    const delivery = {
      id: "delivery_test", tenant_id: "tenant_test", integration_id: "integration_test",
      provider_event_id: "evt_synthetic", status: "received", event_name: "stripe.invoice.paid",
      contact_id: null, error: null, created_at: "2026-10-05",
    };
    for (const limit of [undefined, 150]) {
      const db = mock([row()], [{ ...delivery, body: "synthetic_private_body", secret: signingSecret }]);
      expect(await listDeliveries(db.client, "tenant_test", "integration_test", limit)).toEqual([delivery]);
      const [sql, values] = db.query.mock.calls[1]!;
      expect(values).toEqual(["tenant_test", "integration_test", limit === undefined ? 20 : 100]);
      expect(sql).toContain("order by created_at desc, id desc limit $3");
      expect(sql).not.toMatch(/\*|body|secret/);
    }
    const db = mock([]);
    await expect(listDeliveries(db.client, "other_tenant", "integration_test")).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid delivery limit %s before queries", async limit => {
    const db = mock();
    await expect(listDeliveries(db.client, "tenant_test", "integration_test", limit)).rejects.toMatchObject({ statusCode: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(["23505", "XX000"])("sanitizes credential-bearing database errors %s", async code => {
    const db = mock();
    db.query.mockRejectedValue(Object.assign(new Error(`${signingSecret} ${restrictedKey} ${appSecret}`), {
      code, detail: restrictedKey,
    }));
    let caught: unknown;
    try { await createIntegration(db.client, "tenant_test", input, appSecret); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ statusCode: code === "23505" ? 409 : 500 });
    for (const value of [signingSecret, restrictedKey, appSecret]) {
      expect(String(caught)).not.toContain(value);
      expect(JSON.stringify(caught)).not.toContain(value);
    }
    expect(caught).not.toHaveProperty("cause");
  });

  it("sanitizes invalid credentials and wrong-key PATCH failures without writes", async () => {
    const createDb = mock();
    await expect(createIntegration(createDb.client, "tenant_test", input, "")).rejects.toMatchObject({ statusCode: 500 });
    expect(createDb.query).not.toHaveBeenCalled();
    const updateDb = mock([row()]);
    await expect(updateIntegration(updateDb.client, "tenant_test", "integration_test",
      { settings: { stripe_restricted_key: restrictedKey } }, "synthetic_wrong_secret"))
      .rejects.toThrow("Integration credentials could not be stored");
    expect(updateDb.query).toHaveBeenCalledTimes(1);
  });
});
