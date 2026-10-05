// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Source } from "./editor";

afterEach(cleanup);
it("reports the actual guard refusal with a stable source identity without changing content", async () => {
  const onCheck = vi.fn(), onHtml = vi.fn();
  render(h(Source, { html: '<a href="javascript:alert(1)">Unsafe</a>', text: "", onHtml, onText: vi.fn(), onCheck }));
  expect(onCheck).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Visual" }));
  await waitFor(() => expect(onCheck).toHaveBeenLastCalledWith({
    id: "source.visual", tone: "warn", text: "Visual mode does not open the link javascript:alert(1).",
  }));
  expect(screen.getByRole("textbox", { name: "HTML" })).toHaveProperty("value", '<a href="javascript:alert(1)">Unsafe</a>');
  expect(onHtml).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Convert to visual" })).toBeNull();
});
