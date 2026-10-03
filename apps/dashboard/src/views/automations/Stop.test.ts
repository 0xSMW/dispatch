// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, signIn, wrapper, type Reply } from "../../testing";
import { StopAutomation } from "./Stop";

describe("Stop confirmation", () => {
  beforeEach(() => signIn());
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  function open() {
    const onDone = vi.fn();
    const onClose = vi.fn();
    render(h(StopAutomation, { automation: { id: "automation_1", name: "Welcome" }, onDone, onClose }), { wrapper });
    return { onDone, onClose };
  }

  it.each([0, 1, 1204])("shows %i active runs, not lifetime runs, and warns about destructive Stop", async (count) => {
    const fetch = mockFetch((url, init) => {
      if (init.method === "POST") return { body: { id: "automation_1", status: "disabled" } };
      expect(new URL(url).searchParams.get("start_date")).toBe("1970-01-01T00:00:00.000Z");
      return { body: { total: 9999, totals: { running: count, completed: 6000, failed: 20, cancelled: 10 } } };
    });
    const { onDone, onClose } = open();
    expect(await screen.findByText(`${count.toLocaleString()} ${count === 1 ? "run" : "runs"} in progress will be cancelled.`)).toBeTruthy();
    expect(screen.getByText(/cancels every run in progress, including runs waiting on a delay or event/)).toBeTruthy();
    expect(screen.getByText(/does not restore cancelled runs/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Stop/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: "automation_1", status: "disabled" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("blocks Stop until counts load and after failure, then retries", async () => {
    let release!: (reply: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { release = resolve; });
    let reads = 0;
    const fetch = mockFetch((_url, init) => {
      if (init.method === "POST") return { body: {} };
      return ++reads === 1 ? pending : { body: { totals: { running: 2 } } };
    });
    open();
    const stop = screen.getByRole("button", { name: /^Stop/ });
    expect(stop).toHaveProperty("disabled", true);
    fireEvent.click(stop);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    release({ status: 503, body: { message: "Try later" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(stop).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("2 runs in progress will be cancelled.")).toBeTruthy();
    expect(stop).toHaveProperty("disabled", false);
  });
});
