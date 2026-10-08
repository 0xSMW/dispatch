// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, signIn, wrapper } from "../testing";
import type { ListState } from "../hooks/useList";
import { useSelection } from "../hooks/useSelection";
import { Empty } from "./Empty";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../shell/session";
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
    context: h("a", { href: "/emails/em_1" }, "Email em_1"),
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
    expect(screen.getByRole("link", { name: "Email em_1" }).getAttribute("href")).toBe("/emails/em_1");
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
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

  function Blank({ state = {}, route = "/domains" }: { state?: Partial<typeof list>; route?: string }) {
    return h(MemoryRouter, { initialEntries: [route] }, h(SessionProvider, null,
      h(ListPage<{ id: string; name: string }>, {
        title: "Domains", actions: h("button", null, "Add domain"),
        search: "Search domains", list: { ...list, rows: [], ...state },
        columns: [{ header: "Domain", cell: (row) => row.name }],
        empty: h(Empty, { title: "No domains", body: "Add a domain to start sending." }),
      })));
  }

  it("collapses an empty first page and keeps its creation action in the card", () => {
    signIn(); render(h(Blank));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Page 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Add domain" }).closest(".empty")).toBeTruthy();
  });

  it("keeps filters usable for no matches and restores the empty card on reset", () => {
    signIn(); render(h(Blank, { route: "/domains?q=missing" }));
    expect(screen.getByRole("searchbox")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("No domains")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("never substitutes the first-use card for loading or failed requests", () => {
    signIn(); const view = render(h(Blank, { state: { loading: true } }));
    expect(screen.queryByText("No domains")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
    view.rerender(h(Blank, { state: { error: "Unavailable" } }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("No domains")).toBeNull();
  });

  it("preserves a way back from an empty later page and hides writes for viewers", () => {
    signIn("sess_test", ["read"]);
    render(h(Blank, { state: { page: 2 } }));
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
  });

});
