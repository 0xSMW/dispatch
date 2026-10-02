// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../testing";
import { Time } from "./Time";

describe("Time", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows relative time with the ISO value in title and dateTime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    const { container } = render(h(Time, { value: "2026-10-01T12:00:00Z" }));
    const time = container.querySelector("time")!;
    expect(time.textContent).toBe("5d ago");
    expect(time.getAttribute("title")).toBe("2026-10-01T12:00:00.000Z");
    expect(time.getAttribute("datetime")).toBe("2026-10-01T12:00:00.000Z");
  });

  it("shows a dash for a missing value", () => {
    const { container } = render(h(Time, { value: null }));
    expect(container.textContent).toBe("—");
    expect(container.querySelector("time")).toBeNull();
  });
});
