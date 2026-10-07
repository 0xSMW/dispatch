import { transferableAbortController } from "node:util";

// DOM tests need their own signals for DOM listeners. Bridge them when the router
// creates a native Request, whose Node 24 signal check requires Node's implementation.
if (typeof window !== "undefined") {
  const NativeRequest = Request;
  class BrowserRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const signal = init?.signal;
      if (!signal) {
        super(input, init);
        return;
      }
      const controller = transferableAbortController();
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      super(input, { ...init, signal: controller.signal });
    }
  }
  Object.defineProperty(globalThis, "Request", {
    value: BrowserRequest, configurable: true, writable: true,
  });
}
