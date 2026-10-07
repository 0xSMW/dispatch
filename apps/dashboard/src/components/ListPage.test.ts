// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../testing";
import type { ListState } from "../hooks/useList";
import { useSelection } from "../hooks/useSelection";
import { ListPage } from "./ListPage";
import { Menu } from "./Menu";

const list: ListState<{ id: string; name: string }> = {
  rows: [{ id: "dom_1", name: "acme.com" }],
  hasMore: false,
  loading: false,
  error: null,
  page: 1,
  reload: async () => undefined,
  next: () => undefined,
  previous: () => undefined,
};

function Page({ items = [{ label: "Delete", onSelect: () => undefined }] }: { items?: Array<{ label: string; onSelect: () => void; read?: boolean }> }) {
  const selection = useSelection(["dom_1"]);
  return h(ListPage<{ id: string; name: string }>, {
    title: "Domains",
    learn: [{ label: "DNS records", href: "https://docs.acme.test/domains.md#dns-records" }],
    actions: h("button", { type: "button" }, "Add domain"),
    list,
    columns: [{ header: "Domain", cell: (row) => row.name }],
    menu: () => h(Menu, { items }),
    selection,
    bulkActions: [{ label: "Delete", onClick: () => undefined }],
  });
}

describe("ListPage", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows actions, row menus, and checkboxes with full access", () => {
    signIn();
    render(h(wrapper, null, h(Page)));
    expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select row" })).toBeTruthy();
  });

  it("hides every write from a viewer and keeps the rows", () => {
    signIn("sess_test", ["read"]);
    render(h(wrapper, null, h(Page)));
    expect(screen.getByText("acme.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("link", { name: "DNS records" }).getAttribute("href")).toBe("https://docs.acme.test/domains.md#dns-records");
  });

  it("keeps a viewer's row menu items that only read", () => {
    signIn("sess_test", ["read"]);
    const items = [
      { label: "Copy ID", read: true, onSelect: () => undefined },
      { label: "Delete", onSelect: () => undefined },
    ];
    render(h(wrapper, null, h(Page, { items })));
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: "Copy ID" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });
});
