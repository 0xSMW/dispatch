// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { template, version } from "./fixtures";
import { api, calls, list, renderAt } from "./harness";
import { Template, variableRows } from "./Template";
import { liveVersion, sourceLabel, sourceNotice, versionBody } from "./Versions";

const versions = [
  version({ id: "version_2", subject: "Welcome, {{{NAME}}}", published_at: null, created_at: "2026-09-30T11:00:00.000Z" }),
  version({ id: "version_1", published_at: "2026-09-30T10:00:00.000Z" }),
];

function setup(row = template()) {
  const fetch = api({
    "GET /templates/tpl_1": row,
    "GET /templates/tpl_1/versions": list(versions),
    "GET /brand": { object: "brand" },
    "POST /templates/tpl_1/publish": template({ has_unpublished_versions: false }),
    "PATCH /templates/tpl_1": (_url: URL, init: RequestInit) => ({ body: { ...row, ...JSON.parse(String(init.body)) } }),
  });
  renderAt("/templates/tpl_1", [{ path: "/templates/:id", element: h(Template) }]);
  return fetch;
}

describe("Template", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows facts, a filled preview, and the variables with their fallbacks", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.getByText("tpl_1")).toBeTruthy();
    const frame = await waitFor(() => {
      const element = document.querySelector("iframe");
      if (!element) throw new Error("no preview");
      return element;
    });
    expect(frame.getAttribute("srcdoc")).toContain("Hi [NAME], your plan is Free.");
    const variables = screen.getByRole("heading", { name: "Variables" }).closest("section")!;
    expect(within(variables).getByText("NAME")).toBeTruthy();
    expect(within(variables).getByText(/None, required/)).toBeTruthy();
    expect(within(variables).getByText("Free")).toBeTruthy();
  });

  it("lists versions with the live one marked", async () => {
    setup();
    const panel = (await screen.findByRole("heading", { name: "Versions" })).closest("section")!;
    await within(panel).findByText("version_1");
    const live = within(panel).getByText("version_1").closest("tr")!;
    expect(within(live).getByText("Live")).toBeTruthy();
    const draft = within(panel).getByText("version_2").closest("tr")!;
    expect(within(draft).getByText("Draft")).toBeTruthy();
  });

  it("marks the live version by published_version_id, not by time", async () => {
    setup(template({ published_version_id: "version_2", has_unpublished_versions: false }));
    const panel = (await screen.findByRole("heading", { name: "Versions" })).closest("section")!;
    await within(panel).findByText("version_2");
    expect(within(within(panel).getByText("version_2").closest("tr")!).getByText("Live")).toBeTruthy();
    expect(within(within(panel).getByText("version_1").closest("tr")!).queryByText("Live")).toBeNull();
  });

  it("shows tracking and turns it off with PATCH { track }", async () => {
    const fetch = setup();
    const toggle = await screen.findByRole("switch", { name: "Opens and clicks" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(calls(fetch, "PATCH /templates/tpl_1")[0]?.body).toEqual({ track: false }));
    expect((await screen.findByRole("switch", { name: "Off" })).getAttribute("aria-checked")).toBe("false");
  });

  it("publishes the latest version", async () => {
    const fetch = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(calls(fetch, "POST /templates/tpl_1/publish")).toHaveLength(1));
    expect(calls(fetch, "POST /templates/tpl_1/publish")[0]!.body).toEqual({});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Publish" })).toBeNull());
  });

  it("publishes an older version by id", async () => {
    const fetch = setup();
    const panel = (await screen.findByRole("heading", { name: "Versions" })).closest("section")!;
    await within(panel).findByText("version_2");
    const row = within(panel).getByText("version_2").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Publish this version" }));
    await waitFor(() => expect(calls(fetch, "POST /templates/tpl_1/publish")[0]?.body).toEqual({ version_id: "version_2" }));
  });

  it("shows the source notice only when the API sends a library or React Email source", async () => {
    setup(template({ source: { kind: "library", slug: "welcome", version: "1.0.0" } }));
    expect(await screen.findByText(/Installed from the template library \(welcome\)/)).toBeTruthy();
    cleanup();
    setup();
    await screen.findByRole("heading", { name: "Welcome" });
    expect(screen.queryByText(/Installed from|Pushed from/)).toBeNull();
  });
});

describe("Template helpers", () => {
  it("lists declared variables and flags used but undeclared ones", () => {
    const rows = variableRows({ subject: null, text: null, html: "{{{NAME}}} {{{EXTRA}}} {{{PRODUCT_NAME}}}", variables: ["NAME", "OLD"] });
    expect(rows.map((row) => [row.key, row.declared, row.used])).toEqual([
      ["NAME", true, true],
      ["OLD", true, false],
      ["EXTRA", false, true],
    ]);
  });

  it("finds the live version by published_version_id", () => {
    expect(liveVersion(template(), versions)?.id).toBe("version_1");
    expect(liveVersion(template({ published_version_id: "version_2" }), versions)?.id).toBe("version_2");
    expect(liveVersion(template({ status: "draft", published_at: null, published_version_id: null }), versions)).toBeUndefined();
  });

  it("names a version's source", () => {
    expect(sourceLabel({ kind: "react-email", path: "emails/reset.tsx" })).toBe("emails/reset.tsx");
    expect(sourceLabel({ kind: "library", slug: "welcome" })).toBe("Library");
    expect(sourceLabel(null)).toBe("Dashboard or API");
  });

  it("words the notice by source kind", () => {
    expect(sourceNotice({ kind: "react-email", path: "emails/reset.tsx" })).toBe(
      "Pushed from emails/reset.tsx. Changes made here are overwritten by the next push.",
    );
    expect(sourceNotice({})).toBeNull();
    expect(sourceNotice(undefined)).toBeNull();
  });

  it("copies a version into a draft body without nulls", () => {
    expect(versionBody(version({ html: null, subject: "Hi", variables: ["NAME"] }))).toEqual({
      subject: "Hi",
      from: "Acme <hello@acme.test>",
      variables: [{ key: "NAME", type: "string", fallback_value: null }],
    });
  });
});
