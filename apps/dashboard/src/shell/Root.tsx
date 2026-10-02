import { Outlet } from "react-router-dom";
import { Toaster } from "../components/Toast";
import { useHotkey } from "../hooks/useHotkey";
import { shortcuts } from "../lib/shortcuts";
import { SessionProvider } from "./session";
import { useTheme } from "./theme";

/** Top of the route tree: session, toasts, and the `M` theme key. Public pages render here too. */
export function Root() {
  const [, toggleTheme] = useTheme();
  useHotkey(shortcuts.theme.combo, toggleTheme);
  return (
    <SessionProvider>
      <Outlet />
      <Toaster />
    </SessionProvider>
  );
}
