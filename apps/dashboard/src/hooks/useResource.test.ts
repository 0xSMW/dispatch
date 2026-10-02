// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockFetch, signIn, wrapper, type Reply } from "../testing";
import { useAll, useResource } from "./useResource";

type Row = { id: string };

describe("useResource", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("drops the old object as soon as the path changes", async () => {
    let release: (reply: Reply) => void = () => undefined;
    mockFetch((url) => {
      if (url.endsWith("/emails/a")) return { body: { id: "a" } };
      return new Promise<Reply>((resolve) => {
        release = resolve;
      });
    });
    const { result, rerender } = renderHook(({ path }) => useResource<Row>(path), { wrapper, initialProps: { path: "/emails/a" } });
    await waitFor(() => expect(result.current.data?.id).toBe("a"));
    rerender({ path: "/emails/b" });
    // B is still loading. A must not show under B's URL.
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(result.current.loading).toBe(true);
    await act(async () => release({ body: { id: "b" } }));
    await waitFor(() => expect(result.current.data?.id).toBe("b"));
  });

  it("keeps the data when a reload of the same object fails", async () => {
    let fail = false;
    mockFetch(() => (fail ? { status: 502, body: { name: "application_error", message: "Bad gateway" } } : { body: { id: "a" } }));
    const { result } = renderHook(() => useResource<Row>("/emails/a"), { wrapper });
    await waitFor(() => expect(result.current.data?.id).toBe("a"));
    fail = true;
    await act(async () => result.current.reload());
    expect(result.current.error).toBe("Bad gateway");
    expect(result.current.data?.id).toBe("a");
  });

  it("ignores an answer that arrives after a newer request", async () => {
    const waiting: Array<(reply: Reply) => void> = [];
    mockFetch(() => new Promise<Reply>((resolve) => waiting.push(resolve)));
    const { result } = renderHook(() => useResource<{ id: string; n: number }>("/emails/a"), { wrapper });
    await waitFor(() => expect(waiting).toHaveLength(1));
    act(() => void result.current.reload());
    await waitFor(() => expect(waiting).toHaveLength(2));
    await act(async () => waiting[1]!({ body: { id: "a", n: 2 } }));
    await act(async () => waiting[0]!({ body: { id: "a", n: 1 } }));
    expect(result.current.data?.n).toBe(2);
  });
});

describe("useAll", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("reads every page, so the 101st segment can be picked", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: `seg_${index}` }));
    const fetch = mockFetch((url) => {
      const after = new URL(url).searchParams.get("after");
      return after === "seg_99" ? { body: { object: "list", has_more: false, data: [{ id: "seg_100" }] } } : { body: { object: "list", has_more: true, data: first } };
    });
    const { result } = renderHook(() => useAll<Row>("/segments"), { wrapper });
    await waitFor(() => expect(result.current.data?.data).toHaveLength(101));
    expect(result.current.data?.has_more).toBe(false);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["http://localhost:3100/segments?limit=100", "http://localhost:3100/segments?limit=100&after=seg_99"]);
  });
});
