// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHotkey } from "../hooks/useHotkey";
import { applyTheme, getTheme, themeKey, toggleTheme, useTheme } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(cleanup);

  it("is dark by default", () => {
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("restores a stored choice", () => {
    localStorage.setItem(themeKey, "light");
    applyTheme();
    expect(getTheme()).toBe("light");
  });

  it("toggles and stores the choice under dispatch.theme", () => {
    applyTheme();
    toggleTheme();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("dispatch.theme")).toBe("light");
    toggleTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("dispatch.theme")).toBe("dark");
  });

  it("toggles on the M key, but not while typing", () => {
    applyTheme();
    const { result } = renderHook(() => {
      const [theme, toggle] = useTheme();
      useHotkey("m", toggle);
      return theme;
    });
    expect(result.current).toBe("dark");

    act(() => {
      fireEvent.keyDown(document, { key: "m" });
    });
    expect(result.current).toBe("light");

    const input = document.createElement("input");
    document.body.append(input);
    act(() => {
      fireEvent.keyDown(input, { key: "m" });
    });
    expect(result.current).toBe("light");
    input.remove();

    act(() => {
      fireEvent.keyDown(document, { key: "m", metaKey: true });
    });
    expect(result.current).toBe("light");
  });
});
