import { changeControl, controlValue } from "../../testingControls";
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import type { Integration } from "../../types";
import { IntegrationFields, integrationDraft, integrationPayload, mappedEvents, validDraft } from "./IntegrationFields";

const stripe: Integration = {
  object: "integration", id: "int_1", provider: "stripe", name: "Billing", slug: "stripe",
  settings: { map_plan: true }, has_restricted_key: true, last_received_at: null,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};

afterEach(cleanup);

describe("integration fields", () => {
  it("starts with blank credentials and omits unchanged credentials on edit", () => {
    const value = integrationDraft(stripe);
    expect(value.secret).toBe("");
    expect(value.restrictedKey).toBe("");
    expect(integrationPayload(value, true)).toEqual({ name: "Billing", settings: { map_plan: true } });
    expect(validDraft(value, true)).toBe(true);
    expect(validDraft(value)).toBe(false);
  });

  it("supports replacing and explicitly removing the restricted key", () => {
    const value = { ...integrationDraft(stripe), restrictedKey: "rk_new", secret: "whsec_new" };
    expect(integrationPayload(value, true)).toEqual({
      name: "Billing", secret: "whsec_new", settings: { map_plan: true, stripe_restricted_key: "rk_new" },
    });
    expect(integrationPayload({ ...value, removeKey: true }, true).settings?.stripe_restricted_key).toBeNull();
    const change = vi.fn();
    render(h(IntegrationFields, { value, onChange: change, integration: stripe }));
    expect((screen.getByLabelText("Signing secret") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("Restricted Stripe key") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("switch", { name: "Remove restricted key" }));
    expect(change).toHaveBeenCalledWith({ ...value, removeKey: true, restrictedKey: "" });
  });

  it("makes Clerk deletion an explicit false default and excludes other settings", () => {
    const value = { ...integrationDraft(), provider: "clerk" as const, name: "Users", secret: "whsec_test", restrictedKey: "stale" };
    expect(integrationPayload(value)).toEqual({ provider: "clerk", name: "Users", secret: "whsec_test", settings: { delete_contact: false } });
    render(h(IntegrationFields, { value, onChange: vi.fn() }));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/ordinary contact deletion, not privacy erasure/)).toBeTruthy();
  });

  it("uses Supabase's configurable header and validates its grammar", () => {
    const value = { ...integrationDraft(), provider: "supabase" as const, name: "Users", secret: "shared" };
    expect(integrationPayload(value).settings).toEqual({ secret_header: "x-webhook-secret" });
    expect(validDraft(value)).toBe(true);
    expect(validDraft({ ...value, secretHeader: "bad header" })).toBe(false);
    expect(validDraft({ ...value, secretHeader: "" })).toBe(false);
  });

  it("defaults webhook namespace and rejects reserved or malformed namespaces", () => {
    const value = { ...integrationDraft(), provider: "webhook" as const, name: "App", secret: "secret" };
    expect(integrationPayload(value).slug).toBe("webhook");
    expect(validDraft(value)).toBe(true);
    for (const slug of ["stripe", "clerk", "supabase", "@app", "App", "a".repeat(64), ""]) {
      expect(validDraft({ ...value, slug })).toBe(false);
    }
    expect(validDraft({ ...value, slug: "my-app" })).toBe(true);
  });

  it("resets provider-only state and credentials when switching providers", () => {
    const value = { ...integrationDraft(stripe), secret: "secret", restrictedKey: "rk_old" };
    const change = vi.fn();
    render(h(IntegrationFields, { value, onChange: change }));
    changeControl(screen.getByLabelText("Provider"), { target: { value: "clerk" } });
    expect(change).toHaveBeenCalledWith({ ...integrationDraft(), provider: "clerk", name: "Billing" });
  });

  it("shows namespaced mappings without internal automation events", () => {
    expect(mappedEvents.stripe).toHaveLength(20);
    expect(mappedEvents.clerk).toHaveLength(3);
    expect(mappedEvents.supabase).toHaveLength(2);
    expect([...mappedEvents.stripe, ...mappedEvents.clerk, ...mappedEvents.supabase].every((name) => !name.startsWith("@"))).toBe(true);
    render(h(IntegrationFields, { value: integrationDraft(stripe), onChange: vi.fn(), integration: stripe }));
    expect(screen.getByText("stripe.invoice.payment_failed")).toBeTruthy();
    expect(screen.getByLabelText("Provider").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/hosted invoice payment link/)).toBeTruthy();
  });
});
