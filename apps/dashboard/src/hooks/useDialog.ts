import { useEffect, useRef, type RefObject } from "react";

const stack: number[] = [];
let nextId = 1;

const focusable = `a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]):not([aria-hidden='true']), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])`;

/**
 * Shared behavior for `Modal` and `Drawer`: focus moves in on open and back out on close,
 * Tab stays inside, and Esc closes only the topmost open dialog.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  isOpen: boolean,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const id = nextId++;
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // React's autoFocus has already run when focus is inside; otherwise focus the first field.
    if (node && !node.contains(document.activeElement)) {
      const first =
        node.querySelector<HTMLElement>("[data-autofocus]") ??
        node.querySelector<HTMLElement>(
          "[role=combobox]:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]):not([aria-hidden='true'])",
        ) ??
        node;
      first.focus();
    }

    function onKey(event: KeyboardEvent) {
      if (stack.at(-1) !== id || !node) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...node.querySelectorAll<HTMLElement>(focusable)];
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
      previous?.focus?.();
    };
  }, [isOpen, ref]);
}
