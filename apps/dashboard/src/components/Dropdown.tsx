import {
  Children,
  isValidElement,
  useId,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import "../styles/dropdown.css";

type Item = { value: string; label: string; disabled: boolean; group?: string };
function plain(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plain(child.props.children)
        : String(child),
    )
    .join("");
}
function choices(
  children: ReactNode,
  group?: string,
  disabled = false,
): Item[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        label?: string;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === "option")
      return [
        {
          value: String(child.props.value ?? plain(child.props.children)),
          label: child.props.label ?? plain(child.props.children),
          disabled: disabled || !!child.props.disabled,
          group,
        },
      ];
    return choices(
      child.props.children,
      child.type === "optgroup" ? child.props.label : group,
      disabled || !!child.props.disabled,
    );
  });
}

/** Styled single select. The native control retains form serialization, reset and validation. */
export function Dropdown({
  children,
  className,
  style,
  id,
  value,
  defaultValue,
  disabled,
  autoFocus,
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  tabIndex,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const generated = useId();
  const controlId = id ?? generated;
  const listId = `${controlId}-options`;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(String(value ?? defaultValue ?? ""));
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const search = useRef({ text: "", time: 0 });
  const items = choices(children);
  const current = String(value ?? selected);
  const chosen = items.find((item) => item.value === current) ?? items[0];
  const enabled = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);

  useLayoutEffect(() => {
    if (native.current) setSelected(native.current.value);
  }, [value, children]);
  useEffect(() => {
    const form = native.current?.form;
    const reset = () => {
      setOpen(false);
      window.setTimeout(() => setSelected(native.current?.value ?? ""), 0);
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const dialog = trigger.current!.closest<HTMLElement>("[role=dialog]");
      // A translating drawer temporarily establishes the fixed-position containing block.
      // Once its opening animation ends, transform:none restores viewport positioning.
      const transform = dialog ? getComputedStyle(dialog).transform : "none";
      const container = dialog && transform && transform !== "none" ? dialog : null;
      const origin = container?.getBoundingClientRect();
      const offsetX = origin ? origin.left + container!.clientLeft : 0;
      const offsetY = origin ? origin.top + container!.clientTop : 0;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = Math.min(280, Math.max(below, above));
      const desired = Math.min(
        280,
        items.length * 36 +
          12 +
          new Set(items.map((i) => i.group).filter(Boolean)).size * 28,
      );
      const useAbove = below < Math.min(desired, 160) && above > below;
      setPosition({
        left: Math.max(
          8,
          Math.min(rect.left, window.innerWidth - rect.width - 8),
        ) - offsetX,
        top: (useAbove
          ? Math.max(8, rect.top - Math.min(desired, height) - 6)
          : rect.bottom + 6) - offsetY,
        width: Math.min(rect.width, window.innerWidth - 16),
        maxHeight: Math.max(0, Math.min(280, useAbove ? above : below)),
      });
    };
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const dialog = trigger.current?.closest("[role=dialog]");
    place();
    dialog?.addEventListener("animationstart", place);
    dialog?.addEventListener("animationend", place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      dialog?.removeEventListener("animationstart", place);
      dialog?.removeEventListener("animationend", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, items.length]);
  useEffect(() => {
    if (open)
      menu.current
        ?.querySelector(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled || !native.current) return;
    setSelected(item.value);
    native.current.value = item.value;
    native.current.dispatchEvent(new Event("change", { bubbles: true }));
    setOpen(false);
    trigger.current?.focus();
  }
  function show() {
    setActive(
      Math.max(
        0,
        items.findIndex((i) => i.value === chosen?.value && !i.disabled),
      ),
    );
    setOpen(true);
  }
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(event as unknown as KeyboardEvent<HTMLSelectElement>);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        show();
        if (event.key === "Home") setActive(enabled[0] ?? 0);
        if (event.key === "End") setActive(enabled.at(-1) ?? 0);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        choose(active);
        return;
      }
      const cursor = enabled.indexOf(active);
      setActive(
        event.key === "Home"
          ? (enabled[0] ?? 0)
          : event.key === "End"
            ? (enabled.at(-1) ?? 0)
            : (enabled[
                (cursor +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  enabled.length) %
                  enabled.length
              ] ?? 0),
      );
    } else if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const now = Date.now();
      const text =
        now - search.current.time < 700
          ? search.current.text + event.key.toLowerCase()
          : event.key.toLowerCase();
      search.current = { text, time: now };
      const match = items.findIndex(
        (i) => !i.disabled && i.label.toLowerCase().startsWith(text),
      );
      if (match >= 0) {
        if (!open) setOpen(true);
        setActive(match);
      }
      event.preventDefault();
    }
  }
  return (
    <span className={`dropdown ${className ?? ""}`} style={style}>
      <select
        {...props}
        ref={native}
        className="dropdownNative"
        tabIndex={-1}
        aria-hidden="true"
        aria-label={undefined}
        aria-labelledby={undefined}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onInvalid={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
        onChange={(event) => {
          setSelected(event.target.value);
          onChange?.(event);
        }}
      >
        {children}
      </select>
      <button
        ref={trigger}
        id={controlId}
        type="button"
        role="combobox"
        className="dropdownTrigger"
        disabled={disabled}
        autoFocus={autoFocus}
        tabIndex={tabIndex}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        aria-required={props.required}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={key}
        onBlur={(event) => {
          setOpen(false);
          onBlur?.(event as unknown as React.FocusEvent<HTMLSelectElement>);
        }}
        onFocus={(event) =>
          onFocus?.(event as unknown as React.FocusEvent<HTMLSelectElement>)
        }
      >
        <span>{chosen?.label ?? "Select an option"}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={listId}
            role="listbox"
            aria-label={props["aria-label"]}
            aria-labelledby={props["aria-labelledby"] ?? controlId}
            className="dropdownMenu"
            style={position}
            onMouseDown={(event) => event.preventDefault()}
          >
            {items.map((item, index) => (
              <div key={`${item.value}-${index}`}>
                {item.group && item.group !== items[index - 1]?.group ? (
                  <div className="dropdownGroup">{item.group}</div>
                ) : null}
                <div
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={item.value === chosen?.value}
                  aria-disabled={item.disabled || undefined}
                  className={`dropdownOption ${active === index ? "active" : ""}`}
                  onMouseMove={() => !item.disabled && setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span>{item.label}</span>
                  {item.value === chosen?.value ? (
                    <Check size={15} aria-hidden />
                  ) : null}
                </div>
              </div>
            ))}
            {!items.length ? (
              <div className="dropdownEmpty">No options available</div>
            ) : null}
          </div>,
          trigger.current?.closest("[role=dialog]") ?? document.body,
        )}
    </span>
  );
}
