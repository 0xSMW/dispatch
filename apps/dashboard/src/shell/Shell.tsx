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
            <Activity size={18} />
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
        <Account />
      </aside>
      <div className="main">
        <TopBar apiUrl={session.apiUrl} onApi={() => setPanel("api")} onKeys={() => setPanel("keys")} />
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

function TopBar({ apiUrl, onApi, onKeys }: { apiUrl: string; onApi: () => void; onKeys: () => void }) {
  const docs = import.meta.env.VITE_DOCS_URL as string | undefined;
  return (
    <header className="topbar">
      <span className="envChip mono" title="API URL">
        {new URL(apiUrl).host}
      </span>
      <div className="toolbar">
        <button type="button" className="ghost small" onClick={onApi} title="API reference for this page">
          <Code2 size={14} />
          API <kbd>{shortcuts.api.keys[0]}</kbd>
        </button>
        <button type="button" className="ghost icon small" onClick={onKeys} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <Keyboard size={14} />
        </button>
        {docs ? (
          <a className="button ghost small" href={docs} target="_blank" rel="noreferrer">
            <BookOpen size={14} />
            Docs
          </a>
        ) : null}
      </div>
    </header>
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
