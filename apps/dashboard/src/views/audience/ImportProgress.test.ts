// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../../testing";
import { ImportProgress } from "./Import";
import { calls, Status, stubApi } from "./stub";

const path = "/contacts/imports/import_1";
const run = { object: "contact_import", id: "import_1", trigger_automations: false, status: "in_progress", counts: { total: 10, created: 2, updated: 1, skipped: 0, failed: 0 }, error: null, created_at: "", completed_at: null };

describe("Import cancellation", () => {
  beforeEach(() => signIn());
  afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });

  it.each(["queued", "in_progress"])("cancels a %s import without implying earlier writes reverted", async (status) => {
    const fetch = stubApi({ [`GET ${path}`]: { ...run, status }, [`DELETE ${path}`]: { ...run, status: "cancelled" } });
    const onFinish = vi.fn();
    render(h(ImportProgress, { id: "import_1", onFinish }), { wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel import" }));
    await screen.findByText("cancelled");
    expect(calls(fetch)).toContain(`DELETE ${path}`);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("30");
    expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    const count = fetch.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(fetch.mock.calls).toHaveLength(count);
  });

  it("shows a cancellation error and keeps the import visible", async () => {
    stubApi({ [`GET ${path}`]: run, [`DELETE ${path}`]: new Status(409, { name: "conflict", message: "Import could not be cancelled." }) });
    render(h(ImportProgress, { id: "import_1" }), { wrapper });
    expect(await screen.findByText(/not reverted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Import could not be cancelled.");
    expect(screen.getByText("in progress")).toBeTruthy();
  });

  it("keeps viewer progress read-only", async () => {
    signIn("sess_viewer", ["read"]);
    const fetch = stubApi({ [`GET ${path}`]: run });
    render(h(ImportProgress, { id: "import_1" }), { wrapper });
    await screen.findByText("in progress");
    expect(screen.queryByRole("button", { name: "Cancel import" })).toBeNull();
    expect(calls(fetch)).toEqual([`GET ${path}`]);
  });
});
