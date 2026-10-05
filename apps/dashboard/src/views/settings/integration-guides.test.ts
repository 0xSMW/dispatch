import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const docs = new URL("../../../../../docs/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, docs), "utf8");

describe("integration guides", () => {
  it("ships receiver setup anchors before manual alternatives for each provider tile", () => {
    for (const provider of ["stripe", "clerk", "supabase", "webhook"]) {
      const guide = read(`templates/${provider}.md`);
      expect(guide).toContain("## Receiver setup");
      expect(guide.indexOf("## Receiver setup")).toBeLessThan(guide.indexOf("## Manual"));
      expect(guide).toContain("../integrations.md#delivery-history-and-replay-retention");
    }
    expect(read("integrations.md")).toContain("## Delivery history and replay retention");
  });

  it("ships outgoing, SMTP and auth setup destinations", () => {
    expect(read("webhooks.md")).toContain("#");
    expect(read("smtp.md")).toContain("#");
    expect(read("templates/authjs.md")).toContain("sendVerificationRequest");
    expect(read("templates/better-auth.md")).toContain("sendVerificationOTP");
  });

  it("uses the same API URL variable in receiver and manual sending examples", () => {
    for (const name of ["stripe", "clerk", "supabase", "authjs", "better-auth"]) {
      const guide = read(`templates/${name}.md`);
      expect(guide).toContain("process.env.DISPATCH_API_URL");
      expect(guide).not.toContain("DISPATCH_BASE_URL");
    }
  });
});
