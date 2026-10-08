// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Table, rowCountLabel } from "./Table";
import { SessionProvider } from "../shell/session";
import { signIn } from "../testing";

function show(page: number, hasMore: boolean) {
  signIn();
  render(<SessionProvider><Table rows={[{ id: "one", name: "News" }]} columns={[{ header: "Name", cell: row => row.name }]} page={page} hasMore={hasMore} noun="topics" /></SessionProvider>);
}

afterEach(() => { cleanup(); sessionStorage.clear(); });
describe("Table pagination", () => {
  it("shows a singular count without useless controls on one page", () => {
    show(1, false);
    expect(screen.getByText("1 topic")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  });
  it("retains paging when there is a next or previous page", () => {
    show(2, false);
    expect(screen.getByText("Page 2 · 1 topic")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("handles the existing regular and property nouns", () => {
    expect(rowCountLabel(1, "properties")).toBe("1 property");
    expect(rowCountLabel(2, "properties")).toBe("2 properties");
    expect(rowCountLabel(1, "API keys")).toBe("1 API key");
  });
});
