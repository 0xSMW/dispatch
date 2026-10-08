// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { broadcast, segment, topic } from "../templates/fixtures";
import { api, calls, list, renderAt } from "../templates/harness";
import { broadcastHref, Broadcasts, createBody, deletable } from "./Broadcasts";

const rows = [broadcast(), broadcast({ id: "broadcast_2", name: "September news", status: "sent", sent_at: "2026-09-15T10:00:00.000Z" })];

function setup(path = "/broadcasts") {
  const fetch = api({
    "GET /broadcasts": list(rows),
    "GET /segments": list([segment]),
    "GET /topics": list([topic]),
    "POST /broadcasts": broadcast({ id: "broadcast_new" }),
    "POST /broadcasts/broadcast_2/duplicate": broadcast({ id: "broadcast_copy" }),
  });
  const router = renderAt(path, [
    { path: "/broadcasts", element: h(Broadcasts) },
    { path: "/broadcasts/:id/editor", element: h("p", null, "Editor page") },
  ]);
  return { fetch, router };
}

describe("Broadcasts", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists broadcasts with status badges and segment names", async () => {
    setup();
    const row = (await screen.findByText("September news")).closest("tr")!;
    expect(within(row).getByText("Sent")).toBeTruthy();
    await within(row).findByText("Customers");
    expect(screen.getByRole("link", { name: "October update" }).getAttribute("href")).toBe("/broadcasts/broadcast_1/editor");
    expect(screen.getByRole("link", { name: "September news" }).getAttribute("href")).toBe("/broadcasts/broadcast_2");
  });

  it("offers a useful empty-state primary action", async () => {
    api({ "GET /broadcasts": list([]), "GET /segments": list([segment]), "GET /topics": list([topic]) });
    renderAt("/broadcasts", [{ path: "/broadcasts", element: h(Broadcasts) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Create your first broadcast" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("sends search, status, and segment from the URL to the API", async () => {
    const { fetch } = setup("/broadcasts?status=sent&segment_id=seg_1&q=news");
    await screen.findByText("September news");
    const url = calls(fetch, "GET /broadcasts")[0]!.url;
    expect(url.searchParams.get("status")).toBe("sent");
    expect(url.searchParams.get("segment_id")).toBe("seg_1");
    expect(url.searchParams.get("q")).toBe("news");
    expect(screen.getByRole("searchbox", { name: "Search by name or subject" })).toBeTruthy();
  });

  it("preserves a broadcast draft while refreshing an empty segment list", async () => {
    let available = false;
    api({ "GET /broadcasts": list(rows), "GET /segments": () => ({ body: list(available ? [segment] : []) }), "GET /topics": list([topic]) });
    renderAt("/broadcasts", [{ path: "/broadcasts", element: h(Broadcasts) }]);
    fireEvent.click(await screen.findByRole("button", { name: "Create broadcast" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/^Subject/), { target: { value: "Keep my subject" } });
    await dialog.findByText("Create a segment to choose who receives this broadcast.");
    expect(dialog.getByRole("link", { name: "Create segment" }).getAttribute("target")).toBe("_blank");
    available = true;
    fireEvent.click(dialog.getByRole("button", { name: "Refresh segments" }));
    await waitFor(() => expect(dialog.queryByText("Create a segment to choose who receives this broadcast.")).toBeNull());
    expect((dialog.getByLabelText(/^Subject/) as HTMLInputElement).value).toBe("Keep my subject");
  });

  it("creates a draft and opens the editor", async () => {
    const { fetch, router } = setup();
    await screen.findByText("October update");
    fireEvent.click(screen.getByRole("button", { name: "Create broadcast" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/^From/), { target: { value: "news@acme.test" } });
    await waitFor(() => expect(dialog.getByLabelText(/^Segment/).textContent).toContain("Choose a segment"));
    fireEvent.change(dialog.getByLabelText(/^Segment/).closest(".dropdown")!.querySelector("select")!, { target: { value: "seg_1" } });
    fireEvent.change(dialog.getByLabelText(/^Subject/), { target: { value: "Hello" } });
    fireEvent.click(dialog.getByRole("button", { name: /Create draft/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/broadcasts/broadcast_new/editor"));
    expect(calls(fetch, "POST /broadcasts")[0]!.body).toEqual({ from: "news@acme.test", segment_id: "seg_1", subject: "Hello" });
  });

  it("duplicates a sent broadcast and hides delete for it", async () => {
    const { fetch, router } = setup();
    await screen.findByText("September news");
    fireEvent.click(screen.getAllByRole("button", { name: "Actions for September news" })[0]!);
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/broadcasts/broadcast_copy/editor"));
    expect(calls(fetch, "POST /broadcasts/broadcast_2/duplicate")).toHaveLength(1);
  });
});

describe("Broadcasts helpers", () => {
  it("routes drafts to the editor and the rest to detail", () => {
    expect(broadcastHref({ id: "b", status: "draft" })).toBe("/broadcasts/b/editor");
    expect(broadcastHref({ id: "b", status: "queued" })).toBe("/broadcasts/b");
  });

  it("allows delete for draft, scheduled, and canceled only", () => {
    expect(["draft", "scheduled", "queued", "sent", "canceled"].filter(deletable)).toEqual(["draft", "scheduled", "canceled"]);
  });

  it("leaves empty fields out of the create body", () => {
    expect(createBody({ name: "", from: " a@x.test ", segment_id: "seg_1", topic_id: "", subject: "Hi" })).toEqual({
      from: "a@x.test",
      segment_id: "seg_1",
      subject: "Hi",
    });
  });
});
