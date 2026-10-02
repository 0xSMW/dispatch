// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAt, mockFetch, signIn, wrapper } from "../testing";
import { useList, type Filters } from "./useList";

type Row = { id: string };

function pages() {
  // Two pages: [a, b] then [c]. The cursor is the last id of the page before.
  return mockFetch((url) => {
    const query = new URL(url).searchParams;
    if (query.get("after") === "b") return { body: { object: "list", has_more: false, data: [{ id: "c" }] } };
    return { body: { object: "list", has_more: true, data: [{ id: "a" }, { id: "b" }] } };
  });
}

describe("useList", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("walks forward with the last id as `after` and back by popping the trail", async () => {
    const fetch = pages();
    const { result } = renderHook(() => useList<Row>("/domains"), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.current.page).toBe(1);
    expect(result.current.hasMore).toBe(true);
    expect(callAt(fetch).url).toBe("http://localhost:3100/domains?limit=40");

    act(() => result.current.next());
    await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(["c"]));
    expect(result.current.page).toBe(2);
    expect(result.current.hasMore).toBe(false);
    expect(callAt(fetch, -1).url).toContain("after=b");

    act(() => result.current.next());
    expect(result.current.page).toBe(2);

    act(() => result.current.previous());
    await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(["a", "b"]));
    expect(result.current.page).toBe(1);
  });

  it("returns to page one when a filter changes", async () => {
    const fetch = pages();
    const { result, rerender } = renderHook(({ filters }: { filters: Filters }) => useList<Row>("/emails", filters), {
      wrapper,
      initialProps: { filters: {} },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.next());
    await waitFor(() => expect(result.current.page).toBe(2));

    rerender({ filters: { status: "bounced" } });
    expect(result.current.page).toBe(1);
    await waitFor(() => expect(result.current.rows.map((row) => row.id)).toEqual(["a", "b"]));
    const last = new URL(callAt(fetch, -1).url);
    expect(last.searchParams.get("status")).toBe("bounced");
    expect(last.searchParams.get("after")).toBeNull();
  });

  it("drops empty filters from the query and reports errors", async () => {
    const fetch = mockFetch(() => ({ status: 500, body: { name: "application_error", statusCode: 500, message: "Boom" } }));
    const { result } = renderHook(() => useList<Row>("/logs", { status: undefined, q: "" }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(callAt(fetch).url).toBe("http://localhost:3100/logs?limit=40");
    expect(result.current.error).toBe("Boom");
    expect(result.current.rows).toEqual([]);
  });
});
