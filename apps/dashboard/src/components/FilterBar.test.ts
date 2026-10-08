// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { h } from "../testing";
import { FilterBar } from "./FilterBar";

afterEach(cleanup);

it("keeps acronyms in default filter labels and lowercases ordinary words", () => {
  render(h(MemoryRouter, null, h(FilterBar, { search: false, filters: [
    { param: "api_key_id", label: "API key", options: [] },
    { param: "status", label: "Status", options: [] },
  ] })));
  expect(screen.getByRole("combobox", { name: "API key" }).textContent).toBe("All API key");
  expect(screen.getByRole("combobox", { name: "Status" }).textContent).toBe("All status");
});
