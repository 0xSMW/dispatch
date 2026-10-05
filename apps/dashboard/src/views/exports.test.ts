// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { toCsv } from "../components/CsvExport";
import { segmentCsv } from "./audience/Segments";
import { propertyCsv } from "./audience/Properties";
import { broadcastCsv } from "./broadcasts/Broadcasts";
import { domainCsv } from "./domains/Domains";
import { keyCsv } from "./keys/Keys";
import { webhookCsv } from "./webhooks/Webhooks";
import * as tabs from "./tabs";

// The CSV export each list page offers.
describe("list exports", () => {
  it("does not export obsolete automation Events tabs", () => {
    expect("automationTabs" in tabs).toBe(false);
    expect(Object.values(tabs).flat().some((tab) => tab.to === "/automations/events")).toBe(false);
  });
  it("writes a header row and one line per row", () => {
    expect(toCsv([{ id: "seg_1", name: "VIP, gold", contacts: 3, created_at: "2026-09-01" }] as never[], segmentCsv)).toBe(
      'id,name,contacts,created_at\r\nseg_1,"VIP, gold",3,2026-09-01\r\n',
    );
  });

  it("covers the columns each page shows", () => {
    expect(broadcastCsv.map((column) => column.header)).toEqual(["id", "name", "status", "segment_id", "scheduled_at", "sent_at", "created_at"]);
    expect(keyCsv.map((column) => column.header)).toEqual(["id", "name", "token", "permission", "domain_id", "last_used_at", "created_at"]);
    expect(webhookCsv.map((column) => column.value({ events: ["email.sent", "email.delivered"] } as never))[3]).toBe("email.sent email.delivered");
    expect(propertyCsv.map((column) => column.header)).toEqual(["id", "key", "type", "fallback_value", "created_at"]);
    expect(domainCsv.map((column) => column.header)).toEqual(["id", "name", "status", "region", "created_at"]);
  });
});
