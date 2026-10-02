// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { fallbackValue, Properties } from "./Properties";
import { bodyOf, calls, list, show, stubApi } from "./stub";

const seats = { object: "contact_property", id: "prop_seats", key: "seats", type: "number", fallback_value: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "" };

function api() {
  return stubApi({
    "GET /contact-properties": list([seats]),
    "POST /contact-properties": seats,
    "PATCH /contact-properties/prop_seats": seats,
    "DELETE /contact-properties/prop_seats": { object: "contact_property", id: "prop_seats", deleted: true },
  });
}

function rowAction(text: string, action: string) {
  const row = screen.getByText(text).closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

describe("Properties", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists properties with name, type, and fallback", async () => {
    const fetch = api();
    show(h(Properties), "/audience/properties");
    await screen.findByText("seats");
    expect(calls(fetch)).toContain("GET /contact-properties?limit=40");
    expect(screen.getByText("number")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("creates a number property with a typed fallback and rejects a bad key", async () => {
    const fetch = api();
    show(h(Properties), "/audience/properties");
    await screen.findByText("seats");
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "bad key" } });
    expect(within(dialog).getByText("Letters, digits, and underscores, 50 at most.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "lifetime_value" } });
    fireEvent.change(within(dialog).getByLabelText("Type"), { target: { value: "number" } });
    fireEvent.change(within(dialog).getByLabelText("Fallback value"), { target: { value: "0" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contact-properties"));
    expect(bodyOf(fetch, "POST /contact-properties")).toEqual({ key: "lifetime_value", type: "number", fallback_value: 0 });
  });

  it("edits the fallback and deletes with the key as the phrase", async () => {
    const fetch = api();
    show(h(Properties), "/audience/properties");
    await screen.findByText("seats");
    rowAction("seats", "Edit fallback");
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Fallback value"), { target: { value: "" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(bodyOf(fetch, "PATCH /contact-properties/prop_seats")).toEqual({ fallback_value: null }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    rowAction("seats", "Delete");
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "seats" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /contact-properties/prop_seats"));
  });
});

describe("fallbackValue", () => {
  it("types numbers and turns empty text into null", () => {
    expect(fallbackValue("number", " 12 ")).toBe(12);
    expect(fallbackValue("string", "")).toBeNull();
    expect(fallbackValue("string", "friend")).toBe("friend");
  });
});
