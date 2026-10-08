import { useId, useState, type ReactNode } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookOpen,
  Code2,
  ChevronsUpDown,
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
  Target,
  Tag,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import { CommandMenu } from "./CommandMenu";
import { Menu } from "../components/Menu";
import { useHotkey } from "../hooks/useHotkey";
import { dialogOpen, shortcuts } from "../lib/shortcuts";
import { ApiReference } from "./ApiReference";
import { ChangePassword } from "./ChangePassword";
import { Onboarding } from "./Onboarding";
import { Shortcuts } from "./Shortcuts";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { NavIcon, type IconMotion } from "./NavIcon";
import "../styles/sidebar-motion.css";
import "../styles/account-login.css";

const iconMotion: Record<string, IconMotion> = {
  "/emails": "mail", "/metrics": "bars", "/broadcasts": "broadcast", "/automations": "branches",
  "/templates": "document", "/audience": "people", "/goals": "target", "/domains": "globe",
  "/logs": "logs", "/api-keys": "key", "/webhooks": "webhook", "/timeline": "activity",
  "/events": "bolt", "/settings": "gear",
};

/** One shared menu for desktop, mobile, and every role. */
export const nav = [
  { to: "/emails", label: "Emails", icon: Mail },
  { to: "/metrics", label: "Metrics", icon: BarChart3 },
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { to: "/automations", label: "Automations", icon: GitBranch },
  { to: "/templates", label: "Templates", icon: FileText },
  { to: "/audience", label: "Audience", icon: Users },
  { to: "/audience/topics", label: "Topics", icon: Tag },
  { to: "/goals", label: "Goals", icon: Target },
  { to: "/domains", label: "Domains", icon: Globe2 },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/api-keys", label: "API keys", icon: KeyRound },
  { to: "/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/timeline", label: "Timeline", icon: Activity },
  { to: "/events", label: "Events", icon: Zap },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** Compatibility route retains query state without adding a history entry. */
export function EventsRedirect() {
  const location = useLocation();
  return <Navigate to={`/events${location.search}${location.hash}`} replace />;
}

/** Layout for every signed-in page. Sends visitors without a session to `/login`. */
export function Shell() {
  const { session } = useSession();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const workspace = /^\/automations\/[^/]+\/editor\/?$/.test(location.pathname)
    && params.get("tab") !== "runs" && params.get("tab") !== "metrics" && params.get("view") !== "list";
  const [panel, setPanel] = useState<"api" | "keys" | "commands" | null>(null);
  const open = (next: "api" | "keys" | "commands") => () => {
    if (!panel && !dialogOpen()) setPanel(next);
  };
  useHotkey(shortcuts.commands.combo, () => {
    if (panel === "commands") setPanel(null);
    else open("commands")();
  }, { enabled: Boolean(session) });
  useHotkey(shortcuts.api.combo, open("api"), { enabled: Boolean(session) });
  useHotkey(shortcuts.help.combo, open("keys"), { enabled: Boolean(session) });
  if (!session) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }

  return (
    <div className={workspace ? "app automationWorkspace" : "app"}>
      <aside className="sidebar">
        <Account />
        <nav aria-label="Main">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === "/audience" && location.pathname.startsWith("/audience/topics")} className={({ isActive }) => (isActive ? "navItem active" : "navItem")}>
              <NavIcon icon={Icon} motion={iconMotion[to]} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebarFoot">
          <Tools apiUrl={session.apiUrl} onApi={() => setPanel("api")} onKeys={() => setPanel("keys")} />
        </div>
      </aside>
      <div className="main">
        <main className="content">
          {location.pathname === "/emails" ? <Onboarding /> : null}
          <Outlet />
        </main>
      </div>
      {panel === "commands" ? <CommandMenu pages={nav} onClose={() => setPanel(null)} onApi={() => setPanel("api")} onKeys={() => setPanel("keys")} /> : null}
      {panel === "api" ? <ApiReference apiUrl={session.apiUrl} onClose={() => setPanel(null)} /> : null}
      {panel === "keys" ? <Shortcuts onClose={() => setPanel(null)} /> : null}
    </div>
  );
}

/** Footer icon row: API reference, shortcuts, and docs. The API host shows on hover. */
function Tools({ apiUrl, onApi, onKeys }: { apiUrl: string; onApi: () => void; onKeys: () => void }) {
  const docs = import.meta.env.VITE_DOCS_URL as string | undefined;
  return (
    <div className="sidebarTools">
      <Tool label="API reference" hint={shortcuts.api.keys[0]} detail={new URL(apiUrl).host} onClick={onApi}>
        <NavIcon icon={Code2} motion="code" size={15} />
      </Tool>
      <Tool label="Keyboard shortcuts" hint="?" onClick={onKeys}>
        <NavIcon icon={Keyboard} motion="keyboard" size={15} />
      </Tool>
      <span className="spacer" />
      {docs ? (
        <a className="button ghost icon small" href={docs} target="_blank" rel="noreferrer" aria-label="Docs" title="Docs">
          <BookOpen size={15} />
        </a>
      ) : null}
    </div>
  );
}

/** Hover and focus share a tooltip; clicking or Escape dismisses it. */
function Tool({ label, hint, detail, onClick, children }: {
  label: string; hint: string; detail?: string; onClick: () => void; children: ReactNode;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  useHotkey("escape", () => setVisible(false), { enabled: visible });
  return <span className="sidebarTool" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
    onFocus={() => setVisible(true)} onBlur={() => setVisible(false)}>
    <button type="button" className="ghost icon small" aria-label={label} aria-describedby={visible ? id : undefined}
      onClick={() => { setVisible(false); onClick(); }}>{children}</button>
    <span id={id} role="tooltip" className={`sidebarTooltip${visible ? " visible" : ""}`}>
      <span className="sidebarTooltipRow"><span>{label}</span><kbd>{hint}</kbd></span>
      {detail ? <small>{detail}</small> : null}
    </span>
  </span>;
}

function Account() {
  const { session, signOut } = useSession();
  const [theme, toggleTheme] = useTheme();
  const navigate = useNavigate();
  const [changing, setChanging] = useState(false);
  const email = session?.user?.email ?? "Account";
  const name = session?.user?.name?.trim();
  const initials = name
    ? name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()
    : email.slice(0, 1).toUpperCase();
  return (
    <div className="account">
      <Menu
        placement="down"
        align="start"
        triggerClassName="accountButton"
        trigger={
          <>
            <span className="avatar" aria-hidden>
              {initials}
            </span>
            <span className="accountText">
              <span>{name || email}</span>
              {name ? <span className="dim">{" "}{email}</span> : null}
            </span>
            <ChevronsUpDown className="accountChevron" size={14} aria-hidden />
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
