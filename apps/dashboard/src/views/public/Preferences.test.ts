// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { h } from "../../testing";
import { PreferenceCard, previewBrand } from "./Preferences";
afterEach(cleanup);
it("uses controlled preview outcomes and custom text without moving the brand", () => {
  const brand = previewBrand({
    product_name: "Acme",
    unsubscribe_updated_title: "Saved choices",
    unsubscribe_updated_description: "Thanks for choosing.",
    unsubscribe_unsubscribed_title: "All done",
    unsubscribe_unsubscribed_description: "No more emails.",
  });
  const props = { brand, topics: [], checked: {}, preview: true };
  const view = render(h(PreferenceCard, { ...props, done: "updated" }));
  expect(screen.getByRole("heading", { name: "Saved choices" })).toBeTruthy();
  expect(screen.getByText("Thanks for choosing.")).toBeTruthy();
  expect(screen.getByText("Acme").parentElement?.firstChild).toBe(
    screen.getByText("Acme"),
  );
  view.rerender(h(PreferenceCard, { ...props, done: "unsubscribed" }));
  expect(screen.getByRole("heading", { name: "All done" })).toBeTruthy();
  expect(screen.getByText("No more emails.")).toBeTruthy();
});
it("keeps topic toggles local to a preview", () => {
  render(
    h(PreferenceCard, {
      brand: previewBrand(null),
      topics: [
        {
          id: "news",
          name: "News",
          description: null,
          subscription: "opt_out",
        },
      ],
      checked: { news: false },
      preview: true,
    }),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
  expect(screen.getByRole("status").textContent).toContain(
    "Preferences updated",
  );
});
