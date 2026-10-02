import { describe, expect, it } from "vitest";
import { statusToVariant } from "./Badge";

describe("statusToVariant", () => {
  it("keeps green for confirmed outcomes and grays out `sent`", () => {
    expect(statusToVariant("delivered")).toBe("success");
    expect(statusToVariant("verified")).toBe("success");
    expect(statusToVariant("sent")).toBe("neutral");
    expect(statusToVariant("queued")).toBe("warning");
  });

  it("maps every color family", () => {
    expect(statusToVariant("bounced")).toBe("danger");
    expect(statusToVariant("partially_failed")).toBe("danger");
    expect(statusToVariant("delivery_delayed")).toBe("warning");
    expect(statusToVariant("opened")).toBe("info");
    expect(statusToVariant("clicked")).toBe("accent");
    expect(statusToVariant("draft")).toBe("neutral");
    expect(statusToVariant("canceled")).toBe("neutral");
  });

  it("is case-insensitive and falls back to neutral", () => {
    expect(statusToVariant("DELIVERED")).toBe("success");
    expect(statusToVariant("something_new")).toBe("neutral");
  });

  it("reads event types by their last part", () => {
    expect(statusToVariant("email.bounced")).toBe("danger");
    expect(statusToVariant("email.clicked")).toBe("accent");
  });

  it("colors HTTP codes and classes", () => {
    expect(statusToVariant(200)).toBe("success");
    expect(statusToVariant("204")).toBe("success");
    expect(statusToVariant(404)).toBe("danger");
    expect(statusToVariant(503)).toBe("danger");
    expect(statusToVariant(302)).toBe("neutral");
    expect(statusToVariant("4xx")).toBe("danger");
  });
});
