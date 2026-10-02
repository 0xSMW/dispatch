import { useSyncExternalStore } from "react";
import { CheckCircle2, CircleAlert, X } from "lucide-react";

export type ToastVariant = "success" | "danger" | "info";

export type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
};

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function dismiss(id: number) {
  items = items.filter((item) => item.id !== id);
  emit();
}

/**
 * Shows a short past-tense message in the bottom-right corner, such as "Domain deleted."
 * Works anywhere; `<Toaster />` (mounted once by the root layout) renders it.
 */
export function toast(message: string, variant: ToastVariant = "success", duration = 4000) {
  const id = nextId++;
  items = [...items, { id, message, variant }].slice(-4);
  emit();
  if (duration > 0) setTimeout(() => dismiss(id), duration);
  return id;
}

toast.success = (message: string) => toast(message, "success");
toast.error = (message: string) => toast(message, "danger", 6000);
toast.info = (message: string) => toast(message, "info");

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts() {
  return useSyncExternalStore(subscribe, () => items, () => items);
}

export function Toaster() {
  const list = useToasts();
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className={`toast ${item.variant}`}>
          {item.variant === "danger" ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          <span>{item.message}</span>
          <button type="button" className="ghost icon small" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
