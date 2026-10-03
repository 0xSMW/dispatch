import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { docsBase, learnLinks } from "./docs";

describe("version-aware public documentation", () => {
  it("pins the fallback to the dashboard package version", () => {
    expect(docsBase("")).toBe(`https://github.com/0xSMW/dispatch/blob/v${version}/docs/`);
    expect(docsBase("  ")).toBe(docsBase(""));
  });

  it("uses a configured docs directory with exactly one trailing slash", () => {
    expect(docsBase("https://docs.acme.test/releases/0.1.0")).toBe("https://docs.acme.test/releases/0.1.0/");
    expect(docsBase(" https://docs.acme.test/releases/0.1.0/// ")).toBe("https://docs.acme.test/releases/0.1.0/");
    expect(learnLinks("automations", { "automations.md": "## Triggers\n## Conditions\n" }, "https://docs.acme.test/v1/")).toEqual([
      { label: "Triggers", href: "https://docs.acme.test/v1/automations.md#triggers" },
      { label: "Conditions", href: "https://docs.acme.test/v1/automations.md#conditions" },
    ]);
  });

  it("targets the planned anchors in shipped public guides", () => {
    const expected = {
      automations: ["automations.md#triggers", "automations.md#conditions"],
      templates: ["templates.md#variables", "templates.md#visual-editor", "templates.md#brand"],
      audience: ["audience.md#properties", "audience.md#segments", "audience.md#topics"],
      domains: ["domains.md#dns-records", "domains.md#route-53", "deliverability/README.md"],
    };
    for (const [area, paths] of Object.entries(expected)) {
      expect(learnLinks(area as keyof typeof expected, undefined, "").map(({ href }) => href.replace(docsBase(""), ""))).toEqual(paths);
    }
  });

  it("keeps the remaining automation guide anchors available without promising future behavior", () => {
    const guides = import.meta.glob<string>("../../../../docs/automations.md", { query: "?raw", import: "default", eager: true });
    const guide = Object.values(guides)[0]!;
    for (const heading of ["Triggers", "Conditions", "Steps", "Re-entry", "Pause"]) expect(guide).toContain(`## ${heading}\n`);
    expect(guide).toContain("not a pause that preserves runs");
    expect(guide).toContain("New contact triggers default to `once`");
    expect(guide).toContain("Explicit enrollment jobs are not shipped yet");
    expect(guide).toContain("CSV imports with `trigger_automations: true`");
  });

  it("hides missing pages and missing anchors, including recipes before they ship", () => {
    expect(learnLinks("templates", {})).toEqual([]);
    expect(learnLinks("automations", { "automations.md": "## Triggers\n" }, "")).toEqual([
      { label: "Triggers", href: `${docsBase("")}automations.md#triggers` },
    ]);
    expect(learnLinks("automations").some(({ label }) => label === "Lifecycle recipes")).toBe(false);
  });

  it("does not mistake example headings inside fenced code for anchors", () => {
    expect(learnLinks("templates", { "templates.md": "```md\n## Variables\n```\n~~~\n## Brand\n~~~\n" })).toEqual([]);
  });

  it("shows recipes only when their public index is included in that version", () => {
    expect(learnLinks("automations", { "automations/README.md": "# Lifecycle recipes\n" }, "")).toEqual([
      { label: "Lifecycle recipes", href: `${docsBase("")}automations/README.md` },
    ]);
  });
});
