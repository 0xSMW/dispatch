import { fireEvent, within } from "@testing-library/react";

/** Exercise visible dropdown options; keep ordinary input changes unchanged. */
export function changeControl(element: HTMLElement, init: Parameters<typeof fireEvent.change>[1]) {
  if (element.getAttribute("role") !== "combobox" || element.tagName === "SELECT") {
    fireEvent.change(element, init);
    return;
  }
  const value = String((init as { target?: { value?: unknown } })?.target?.value ?? "");
  const select = element.parentElement?.querySelector("select");
  const option = [...(select?.options ?? [])].find(item => item.value === value);
  if (!option) throw new Error(`Dropdown option ${JSON.stringify(value)} does not exist`);
  fireEvent.click(element);
  const list = document.getElementById(element.getAttribute("aria-controls") ?? "");
  if (!list) throw new Error("Dropdown did not open");
  fireEvent.click(within(list).getByRole("option", { name: option.label }));
}

export function controlValue(element: HTMLElement): string {
  return element.getAttribute("role") === "combobox" ? element.parentElement?.querySelector("select")?.value ?? "" : (element as HTMLInputElement).value;
}
