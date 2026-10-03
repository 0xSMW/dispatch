import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookOpen,
  Code2,
  FileText,
  GitBranch,
  Globe2,
  Keyboard,
  KeyRound,
  Lock,
  LogOut,
  Mail,
  Megaphone,
  Moon,
  Rocket,
  ScrollText,
  Send,
  Settings,
  Sun,
  Users,
  Webhook,
} from "lucide-react";
import { Menu } from "../components/Menu";
import { useHotkey } from "../hooks/useHotkey";
import { dialogOpen, shortcuts } from "../lib/shortcuts";
import { ApiReference } from "./ApiReference";
import { ChangePassword } from "./ChangePassword";
import { Onboarding } from "./Onboarding";
import { Shortcuts } from "./Shortcuts";
import { useSession } from "./session";
import { useTheme } from "./theme";

/** Sidebar order: sending and content first, then delivery and developer tools, then Settings. */
export const nav = [
  { to: "/emails", label: "Emails", icon: Mail },
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { to: "/automations", label: "Automations", icon: GitBranch },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/audience", label: "Audience", icon: Users },
  { to: "/metrics", label: "Metrics", icon: BarChart3 },
  { to: "/domains", label: "Domains", icon: Globe2 },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/api-keys", label: "API keys", icon: KeyRound },
  { to: "/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/timeline", label: "Timeline", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** Layout for every signed-in page. Sends visitors without a session to `/login`. */
export function Shell() {
  const { session } = useSession();
  const location = useLocation();
  const [panel, setPanel] = useState<"api" | "keys" | null>(null);
  const open = (next: "api" | "keys") => () => {
    if (!panel && !dialogOpen()) setPanel(next);
  };
  useHotkey(shortcuts.api.combo, open("api"), { enabled: Boolean(session) });
  useHotkey(shortcuts.help.combo, open("keys"), { enabled: Boolean(session) });
  if (!session) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark" aria-hidden>
            <Send size={14} />
          </span>
          <span>Dispatch</span>
        </div>
        <nav aria-label="Main">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "navItem active" : "navItem")}>
              <Icon size={16} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebarFoot">
          <Tools apiUrl={session.apiUrl} onApi={() => setPanel("api")} onKeys={() => setPanel("keys")} />
          <Account />
        </div>
      </aside>
      <div className="main">
        <main className="content">
          {location.pathname === "/emails" ? <Onboarding /> : null}
          <Outlet />
        </main>
      </div>
      {panel === "api" ? <ApiReference apiUrl={session.apiUrl} onClose={() => setPanel(null)} /> : null}
      {panel === "keys" ? <Shortcuts onClose={() => setPanel(null)} /> : null}
    </div>
  );
}

/** Icon row above the account menu: API reference, shortcuts, and docs. The API host shows on hover. */
function Tools({ apiUrl, onApi, onKeys }: { apiUrl: string; onApi: () => void; onKeys: () => void }) {
  const docs = import.meta.env.VITE_DOCS_URL as string | undefined;
  return (
    <div className="sidebarTools">
      <button
        type="button"
        className="ghost icon small"
        onClick={onApi}
        aria-label="API reference"
        title={`API reference for this page (${shortcuts.api.keys[0]}) · ${new URL(apiUrl).host}`}
      >
        <Code2 size={15} />
      </button>
      <button type="button" className="ghost icon small" onClick={onKeys} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <Keyboard size={15} />
      </button>
      <span className="spacer" />
      {docs ? (
        <a className="button ghost icon small" href={docs} target="_blank" rel="noreferrer" aria-label="Docs" title="Docs">
          <BookOpen size={15} />
        </a>
      ) : null}
    </div>
  );
}

function Account() {
  const { session, signOut } = useSession();
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();
  const [changing, setChanging] = useState(false);
  const email = session?.user?.email ?? "Account";
  return (
    <div className="account">
      <Menu
        placement="up"
        align="start"
        triggerClassName="accountButton"
        trigger={
          <>
            <span className="avatar" aria-hidden>
              {email.slice(0, 1).toUpperCase()}
            </span>
            <span className="accountText">
              <span>{session?.user?.name ?? email}</span>
              {session?.user?.name ? <span className="dim">{email}</span> : null}
            </span>
          </>
        }
        items={[
          {
            label: theme === "dark" ? "Light theme" : "Dark theme",
            icon: theme === "dark" ? <Sun size={14} /> : <Moon size={14} />,
            hint: shortcuts.theme.keys[0],
            onSelect: toggleTheme,
          },
          { label: "Onboarding", icon: <Rocket size={14} />, onSelect: () => navigate("/setup") },
          { label: "Team", icon: <Users size={14} />, onSelect: () => navigate("/settings/team") },
          { label: "Change password", icon: <Lock size={14} />, onSelect: () => setChanging(true) },
          "divider",
          {
            label: "Sign out",
            icon: <LogOut size={14} />,
            onSelect: () => {
              signOut();
              navigate("/login", { replace: true });
            },
          },
        ]}
      />
      {changing ? <ChangePassword onClose={() => setChanging(false)} /> : null}
    </div>
  );
}
