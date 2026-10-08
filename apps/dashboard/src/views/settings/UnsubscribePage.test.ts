// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn } from "../../testing";
import { api, calls, list, renderAt } from "../templates/harness";
import { UnsubscribeEditor, UnsubscribePage, pagePatch } from "./UnsubscribePage";

const brand = {
  object: "brand",
  product_name: "Acme",
  color: "#123456",
  logo_url: "https://acme.com/logo.png",
  unsubscribe_title: "Your choices",
};
const topics = list([
  {
    id: "t1",
    name: "News",
    description: "Monthly.",
    visibility: "public",
    default_subscription: "opt_out",
  },
  {
    id: "t2",
    name: "Staff",
    description: null,
    visibility: "private",
    default_subscription: "opt_in",
  },
]);
function show(editor = false, permissions = ["full"]) {
  signIn("sess_test", permissions);
  return renderAt(
    editor ? "/settings/unsubscribe-page/edit" : "/settings/unsubscribe-page",
    [
      { path: "/settings/unsubscribe-page", element: h(UnsubscribePage) },
      {
        path: "/settings/unsubscribe-page/edit",
        element: h(UnsubscribeEditor),
      },
    ],
  );
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
describe("Unsubscribe page", () => {
  it("shows one interactive preview, both outcomes and no editing fields", async () => {
    const fetch = api({ "GET /brand": brand, "GET /topics": topics });
    show();
    const preview = screen.getByRole("complementary", {
      name: "Preference page preview",
    });
    expect(
      await within(preview).findByRole("img", { name: "Acme" }),
    ).toBeTruthy();
    expect(within(preview).queryByText("Staff")).toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
    fireEvent.click(within(preview).getByRole("checkbox"));
    expect(
      (within(preview).getByRole("checkbox") as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(
      within(preview).getByRole("button", { name: "Save preferences" }),
    );
    expect(
      within(preview).getByRole("heading", { name: "Preferences updated" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Unsubscribed" }));
    expect(
      within(preview).getByText("You have been unsubscribed."),
    ).toBeTruthy();
    expect(calls(fetch, "PATCH /brand")).toHaveLength(0);
  });
  it("updates drafts live, focuses selected text, validates, saves changed fields only", async () => {
    const fetch = api({
      "GET /brand": brand,
      "GET /topics": topics,
      "PATCH /brand": {
        ...brand,
        unsubscribe_title: null,
        unsubscribe_description: "Pick your topics.",
      },
    });
    show(true);
    await screen.findByText("Your choices");
    fireEvent.click(screen.getByRole("heading", { name: "Your choices" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Title")),
    );
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Pick your topics." },
    });
    expect(
      within(screen.getByLabelText("Preference page preview")).getByText(
        "Pick your topics.",
      ),
    ).toBeTruthy();
    expect(calls(fetch, "PATCH /brand")).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    fireEvent.change(screen.getByLabelText("Page logo URL"), {
      target: { value: "http://insecure.com/logo.png" },
    });
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("HTTPS");
    for (const value of ["https:example.com/logo.png", "HTTPS://example.com/logo.png"]) {
      fireEvent.change(screen.getByLabelText("Page logo URL"), { target: { value } });
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("alert").textContent).toContain("HTTPS");
    }
    fireEvent.change(screen.getByLabelText("Page logo URL"), {
      target: { value: brand.logo_url },
    });
    fireEvent.change(screen.getByLabelText("Page logo URL"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls(fetch, "PATCH /brand")[0]?.body).toEqual({
        unsubscribe_title: null,
        unsubscribe_description: "Pick your topics.",
      }),
    );
    await screen.findByText("Saved");
  });
  it("cancels with no writes and guards Back while dirty", async () => {
    const fetch = api({ "GET /brand": brand, "GET /topics": topics });
    show(true);
    await screen.findByText("Your choices");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("link", { name: "← Back" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /Stay/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("link", { name: "Edit page" });
    expect(calls(fetch, "PATCH /brand")).toHaveLength(0);
  });
  it("keeps failed draft and selections, switches pure preview themes and widths", async () => {
    const fetch = api({
      "GET /brand": brand,
      "GET /topics": topics,
      "PATCH /brand": () => ({ status: 500, body: { message: "Try later" } }),
    });
    show(true);
    await screen.findByText("Your choices");
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Draft title" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    const preview = screen.getByLabelText("Preference page preview");
    expect(preview.className).toContain("dark");
    expect(preview.querySelector(".mobile")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Try later");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Draft title",
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(calls(fetch, "PATCH /brand")).toHaveLength(1);
  });
});

it("exposes no write actions to viewers, including a direct editor visit", async () => {
  const fetch = api({ "GET /brand": brand, "GET /topics": topics });
  show(false, ["read"]);
  await screen.findByText("Your choices");
  expect(screen.queryByRole("link", { name: "Edit page" })).toBeNull();
  cleanup();
  show(true, ["read"]);
  await screen.findByText("Your choices");
  expect((screen.getByLabelText("Title") as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(calls(fetch, "PATCH /brand")).toHaveLength(0);
});
it("edits both explicit success outcomes independently", async () => {
  const fetch = api({ "GET /brand": brand, "GET /topics": topics, "PATCH /brand": { ...brand, unsubscribe_updated_title: "Choices saved", unsubscribe_unsubscribed_description: "No emails remain." } });
  show(true);
  await screen.findByText("Your choices");
  fireEvent.click(screen.getByRole("tab", { name: "Success" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Choices saved" } });
  expect(screen.getByRole("heading", { name: "Choices saved" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Unsubscribed" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "No emails remain." } });
  expect(within(screen.getByLabelText("Preference page preview")).getByText("No emails remain.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls(fetch, "PATCH /brand")[0]?.body).toEqual({ unsubscribe_updated_title: "Choices saved", unsubscribe_unsubscribed_description: "No emails remain." }));
});

it("does not rewrite unchanged saved whitespace when another field changes", () => {
  const saved = { title: "  Original title  ", description: "", button_label: "", updated_title: "", updated_description: "", unsubscribed_title: "", unsubscribed_description: "", logo_url: "", color: "" };
  expect(pagePatch(saved, saved)).toEqual({});
  expect(pagePatch({ ...saved, description: " New description " }, saved)).toEqual({ unsubscribe_description: "New description" });
});
