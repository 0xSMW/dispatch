// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { Topics } from "./Topics";
import { bodyOf, calls, list, show, stubApi } from "./stub";

const news = {
  object: "topic",
  id: "topic_news",
  name: "News",
  key: "news",
  description: "Monthly product news.",
  visibility: "public",
  default_subscription: "opt_in",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "",
};
const internal = { ...news, id: "topic_internal", name: "Internal", key: "internal", description: null, visibility: "private", default_subscription: "opt_out" };

function api() {
  return stubApi({
    "GET /topics": list([news, internal]),
    "GET /brand": { object: "brand", product_name: "Acme", color: "#ffcc00", text_color: "#000000" },
    "POST /topics": news,
    "PATCH /topics/topic_news": news,
    "DELETE /topics/topic_news": { object: "topic", id: "topic_news", deleted: true },
    "GET /topics/topic_news/subscriptions": list([
      { id: "sub_1", contact_id: "contact_ada", email: "ada@example.com", status: "subscribed", subscription: "opt_in", created_at: "", updated_at: "" },
    ]),
    "POST /topics/topic_news/subscriptions": { object: "subscription" },
  });
}

function rowAction(name: string, action: string) {
  const row = screen.getAllByText(name).find((node) => node.closest("tr"))!.closest("tr")!;
  fireEvent.click(within(row).getByRole("button", { name: "Actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}

describe("Topics", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists topics and previews the preference page with public topics and the brand", async () => {
    const fetch = api();
    show(h(Topics), "/audience/topics");
    await screen.findByText("Internal");
    expect(screen.queryByText("Mailing lists your contacts can subscribe to and leave from the preference page.")).toBeNull();
    expect(calls(fetch)).toEqual(expect.arrayContaining(["GET /topics?limit=40", "GET /brand"]));
    const preview = screen.getByRole("complementary", { name: "Preference page preview" });
    await within(preview).findByText("Acme");
    expect(within(preview).getByText("News")).toBeTruthy();
    expect(within(preview).getByText("Monthly product news.")).toBeTruthy();
    expect(within(preview).queryByText("Internal")).toBeNull();
    expect((within(preview).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("creates a topic with a description and a fixed default", async () => {
    const fetch = api();
    show(h(Topics), "/audience/topics");
    await screen.findByText("Internal");
    fireEvent.click(screen.getByRole("button", { name: "Create topic" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This cannot change later.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Tips" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Short tips." } });
    fireEvent.change(within(dialog).getByLabelText("Defaults to"), { target: { value: "opt_out" } });
    fireEvent.change(within(dialog).getByLabelText("Visibility"), { target: { value: "public" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("POST /topics"));
    expect(bodyOf(fetch, "POST /topics")).toEqual({ name: "Tips", description: "Short tips.", default_subscription: "opt_out", visibility: "public" });
  });

  it("edits and deletes a topic", async () => {
    const fetch = api();
    show(h(Topics), "/audience/topics");
    await screen.findByText("Internal");
    rowAction("News", "Edit");
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Product news" } });
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() =>
      expect(bodyOf(fetch, "PATCH /topics/topic_news")).toEqual({ name: "Product news", description: null, visibility: "public" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    rowAction("News", "Delete");
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Confirmation phrase"), { target: { value: "News" } });
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(calls(fetch)).toContain("DELETE /topics/topic_news"));
  });

  it("lists subscribers and flips one", async () => {
    const fetch = api();
    show(h(Topics), "/audience/topics");
    await screen.findByText("Internal");
    rowAction("News", "View subscribers");
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText("ada@example.com");
    fireEvent.click(within(drawer).getByRole("button", { name: "Opt out" }));
    await waitFor(() =>
      expect(bodyOf(fetch, "POST /topics/topic_news/subscriptions")).toEqual({ email: "ada@example.com", status: "opt_out" }),
    );
  });
});
