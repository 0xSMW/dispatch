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
    expect(screen.getByLabelText("Let cancelled contacts enter again")).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("button", { name: /^Stop/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: "automation_1", status: "disabled" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body))).toEqual({ reset_reentry: false });
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

  it("posts the explicit cancelled-contact reset choice", async () => {
    const fetch = mockFetch((_url, init) => ({ body: init.method === "POST" ? { id: "automation_1", status: "disabled" } : { totals: { running: 2 } } }));
    open();
    await screen.findByText("2 runs in progress will be cancelled.");
    fireEvent.click(screen.getByLabelText("Let cancelled contacts enter again"));
    fireEvent.click(screen.getByRole("button", { name: /^Stop and cancel runs/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(new URL(String(post[0])).pathname).toBe("/automations/automation_1/stop");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ reset_reentry: true });
  });

  it.each([{}, { totals: {} }])("does not stop without a usable active-run count (%j)", async (body) => {
    const fetch = mockFetch(() => ({ body }));
    open();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /^Stop and cancel runs/ })).toHaveProperty("disabled", true);
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps reset and stop disabled for a viewer even if the dialog is mounted directly", async () => {
    signIn("sess_viewer", ["read"]);
    const fetch = mockFetch(() => ({ body: { totals: { running: 2 } } }));
    open();
    await screen.findByText("2 runs in progress will be cancelled.");
    expect(screen.getByLabelText("Let cancelled contacts enter again")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /^Stop and cancel runs/ })).toHaveProperty("disabled", true);
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
