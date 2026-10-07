import { brandContext, payloadIssues, renderTemplate } from "@dispatchmail/core";
import { describe, expect, it } from "vitest";
import library from "../library.json";
import { paymentInput } from "./fixtures";
import { presetIssues, presets } from "./presets";
import type { LibraryTemplate } from "./types";

describe("finite build payment input", () => {
  const preset = presets.find((entry) => entry.slug === "failed-payment")!;
  const templates = library.templates as LibraryTemplate[];
  const brand = brandContext({}, { tenantName: "Acme", domain: "example.com", from: "billing@example.com" });

  it("validates declared bindings using actual adapter values, without preview samples", async () => {
    const data = await paymentInput();
    expect(data).toMatchObject({
      AMOUNT: "$49.00", UPDATE_PAYMENT_URL: "https://billing.example/in_library",
      INVOICE_NUMBER: "INV-LIBRARY", invoice_id: "in_library",
    });
    expect(presetIssues(preset, templates.map((entry) => ({ ...entry, sample: {} })), { triggerData: data })).toEqual([]);
    for (const slug of preset.templates) {
      const entry = templates.find((entry) => entry.slug === slug)!;
      const rendered = renderTemplate(entry, data, brand);
      expect(rendered.html).toContain('href="https://billing.example/in_library"');
      expect(JSON.stringify(rendered)).not.toContain("{{{");
    }
  });

  it.each(["AMOUNT", "UPDATE_PAYMENT_URL"])("rejects missing %s at validation and the existing runtime boundary", async (key) => {
    const data = await paymentInput();
    delete data[key];
    const entry = templates.find((entry) => entry.slug === "payment-failed")!;
    expect(entry.sample[key]).toBeTruthy();
    expect(presetIssues(preset, templates, { triggerData: data }).join("\n")).toContain(`required variable ${key}`);
    expect(() => renderTemplate(entry, data, brand)).toThrow(`Missing template variable: ${key}`);
  });

  it("does not make optional event schemas require omitted fields", () => {
    expect(payloadIssues(preset.events[0]!.schema, {})).toEqual([]);
    expect(presetIssues(preset, templates).join("\n")).toContain("required variable AMOUNT");
  });
});
