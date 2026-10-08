// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { chunks, emailsIn, Suppressions } from "./Suppressions";
import { api, list, requests, visit } from "./visit";

const rows = [
  { object: "suppression", id: "sup_1", email: "bounced@example.com", reason: "bounce", origin: "bounce", source_id: null, created_at: "2026-09-30T10:00:00.000Z" },
  { object: "suppression", id: "sup_2", email: "manual@example.com", reason: "manual", origin: "manual", source_id: null, created_at: "2026-09-29T10:00:00.000Z" },
];

describe("Suppressions", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("filters by origin and colors the origin badge", async () => {
    const fetch = api({ "/suppressions": list(rows) });
    visit(h(Suppressions), "/emails/suppressions?origin=bounce", "/emails/suppressions");
    expect(await screen.findByText("bounced@example.com")).toBeTruthy();
    expect(requests(fetch, "GET", "/suppressions")[0].url.searchParams.get("origin")).toBe("bounce");
    expect(screen.getAllByText("bounce").find((node) => node.classList.contains("badge"))?.className).toContain("danger");
    expect(screen.getAllByText("manual").find((node) => node.classList.contains("badge"))?.className).toContain("neutral");
  });

  it("sends search and the date range", async () => {
    const fetch = api({ "/suppressions": list([]) });
    visit(h(Suppressions), "/emails/suppressions?q=bounced&range=custom&start=2026-09-01&end=2026-09-30", "/emails/suppressions");
    await screen.findByText("No matching results");
    const url = requests(fetch, "GET", "/suppressions")[0].url;
    expect(url.searchParams.get("q")).toBe("bounced");
    expect(url.searchParams.get("from")).toBeTruthy();
    expect(url.searchParams.get("to")).toBeTruthy();
  });

  it("adds pasted addresses in one batch call", async () => {
    const fetch = api({ "/suppressions": list([]), "POST /suppressions/batch/add": list([]) });
    visit(h(Suppressions), "/emails/suppressions");
    await screen.findByText("No suppressions");
    fireEvent.click(screen.getByRole("button", { name: "Add email addresses" }));
    fireEvent.change(screen.getByLabelText("Addresses"), { target: { value: "a@x.test, b@x.test\nA@x.test" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add 2/ }));
    await waitFor(() => expect(requests(fetch, "POST", "/suppressions/batch/add")).toHaveLength(1));
    expect(requests(fetch, "POST", "/suppressions/batch/add")[0].body).toEqual({ emails: ["a@x.test", "b@x.test"] });
  });

  it("adds one address with its reason", async () => {
    const fetch = api({ "/suppressions": list([]), "POST /suppressions": rows[1] });
    visit(h(Suppressions), "/emails/suppressions");
    await screen.findByText("No suppressions");
    fireEvent.click(screen.getByRole("button", { name: "Add email addresses" }));
    fireEvent.change(screen.getByLabelText("Addresses"), { target: { value: "one@x.test" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "asked us to stop" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Add/ }));
    await waitFor(() => expect(requests(fetch, "POST", "/suppressions")[0]?.body).toEqual({ email: "one@x.test", reason: "asked us to stop" }));
  });

  it("removes one address after typing it", async () => {
    const fetch = api({ "/suppressions": list(rows), "DELETE /suppressions/sup_2": { object: "suppression", id: "sup_2", deleted: true } });
    visit(h(Suppressions), "/emails/suppressions");
    await screen.findByText("manual@example.com");
    fireEvent.click(screen.getAllByRole("button", { name: "Actions" })[1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "manual@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove address/ }));
    await waitFor(() => expect(requests(fetch, "DELETE", "/suppressions/sup_2")).toHaveLength(1));
  });

  it("removes the selected rows with one batch call", async () => {
    const fetch = api({ "/suppressions": list(rows), "POST /suppressions/batch/remove": list([]) });
    visit(h(Suppressions), "/emails/suppressions");
    await screen.findByText("manual@example.com");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Remove/ }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), { target: { value: "REMOVE 2" } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove addresses/ }));
    await waitFor(() => expect(requests(fetch, "POST", "/suppressions/batch/remove")[0]?.body).toEqual({ ids: ["sup_1", "sup_2"] }));
  });

  it("finds addresses in CSV text and splits batches at 100", () => {
    expect(emailsIn('email,name\n"ada@example.com",Ada\nbob@example.com;x\nnot an email\nADA@example.com')).toEqual(["ada@example.com", "bob@example.com"]);
    expect(chunks(Array.from({ length: 250 }, (_, index) => index)).map((part) => part.length)).toEqual([100, 100, 50]);
  });
});
