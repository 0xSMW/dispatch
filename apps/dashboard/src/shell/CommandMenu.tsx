import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, ChevronRight, Search, type LucideIcon } from "lucide-react";
import { Modal } from "../components/Modal";
import { emailCommand, rankCommands, searchRecords, type Command } from "../lib/commands";
import { audienceTabs, emailTabs, settingsTabs, templateTabs } from "../views/tabs";
import { useCan, useClient, useSession } from "./session";
import { useTheme } from "./theme";
import "../styles/commands.css";

type Page = { to: string; label: string; icon: LucideIcon };
type Recent = Pick<Command, "id" | "label" | "detail" | "to">;

export function CommandMenu({ pages, onClose, onApi, onKeys }: {
  pages: readonly Page[]; onClose: () => void; onApi: () => void; onKeys: () => void;
}) {
  const client = useClient();
  const { session } = useSession();
  const can = useCan();
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [parent, setParent] = useState<Command | null>(null);
  const [search, setSearch] = useState<{ query: string; commands: Command[]; failed: string[]; loading: boolean }>({ query: "", commands: [], failed: [], loading: false });
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // Session-only history is isolated by API and user; credentials never enter the history.
  const historyKey = `dispatch.commands:${session?.apiUrl}:${session?.id ?? session?.user?.email}`;
  const [recent, setRecent] = useState<Recent[]>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(historyKey) ?? "[]");
      return Array.isArray(value) ? value.filter((row): row is Recent => row && typeof row.id === "string" && typeof row.label === "string" && typeof row.detail === "string" && typeof row.to === "string" && row.to.startsWith("/") && !row.to.startsWith("//")).slice(0, 5) : [];
    } catch { return []; }
  });
  // Capture existing page controls before opening another dialog. Their original guards apply.
  const [context] = useState<Command[]>(() => can ? [...document.querySelectorAll<HTMLButtonElement>(".content .pageActions button")]
    .filter((button) => !button.disabled && /^(Create |Add |Import )/.test(button.textContent?.trim() ?? ""))
    .map((button) => ({ id: `context:${button.textContent}`, label: button.textContent?.trim() ?? "", detail: "On this page", group: "On this page", action: () => {
      onClose();
      // Allow the palette's focus trap to unmount before the original dialog opens.
      requestAnimationFrame(() => { if (button.isConnected && !button.disabled) button.click(); });
    } })) : []);

  const navigation: Command[] = [...pages, ...emailTabs, ...audienceTabs, ...templateTabs, ...settingsTabs]
    .filter((page, index, all) => page.to && all.findIndex((other) => other.to === page.to) === index)
    .map((page) => ({ id: `page:${page.to}`, label: page.label, to: page.to!, detail: "Open page", group: "Pages" }));
  const utilities: Command[] = [
    { id: "api", label: "API reference", detail: "For this page", group: "Actions", action: onApi },
    { id: "shortcuts", label: "Keyboard shortcuts", detail: "All shortcuts", group: "Actions", action: onKeys },
    { id: "theme", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", detail: "Appearance", group: "Actions", action: () => { onClose(); toggleTheme(); } },
    ...(can ? [{ id: "send", label: "Send email", detail: "Open the test send form", group: "Actions", to: "/emails/send" }] : []),
  ];
  const trimmed = query.trim();
  const intent = emailCommand(trimmed);
  useEffect(() => {
    if (trimmed.length < 2 || intent || parent) return;
    let active = true;
    const timer = setTimeout(() => {
      setSearch({ query: trimmed, commands: [], failed: [], loading: true });
      void searchRecords(client, trimmed).then((result) => {
        if (active) setSearch({ query: trimmed, ...result, loading: false });
      });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, trimmed, Boolean(intent), parent, retry]);

  const fresh = search.query === trimmed;
  const commands: Command[] = parent ? rankCommands(parent.related ?? [], trimmed) : trimmed
    ? [...(intent ? [intent] : []), ...rankCommands([...context, ...navigation, ...utilities], trimmed), ...(fresh && !intent ? search.commands : [])]
    : [...context, ...recent.map((row) => ({ ...row, group: "Recent" })), ...utilities, ...navigation];
  const index = Math.min(selected, Math.max(0, commands.length - 1));
  const current = commands[index];
  const waiting = !parent && !intent && trimmed.length >= 2 && (!fresh || search.loading);
  const failed = !parent && !intent && fresh ? search.failed : [];

  function choose(command: Command) {
    if (command.action) { command.action(); return; }
    if (!command.to) return;
    const next = [{ id: command.id, label: command.label, detail: command.detail, to: command.to }, ...recent.filter((row) => row.to !== command.to)].slice(0, 5);
    setRecent(next);
    try { sessionStorage.setItem(historyKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    onClose(); navigate(command.to);
  }
  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: "nearest" });
  }, [index, listId, query, commands.length]);

  return <Modal isOpen title={parent ? parent.label : "Search or jump"} onClose={onClose} size="medium">
    <div className="commandPalette">
      <div className="commandInput">
        <Search size={18} aria-hidden />
        <input ref={input} aria-label="Search pages, records, and actions" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={current ? `${listId}-${index}` : undefined} aria-autocomplete="list"
          placeholder={parent ? "Search actions..." : "Search pages, emails, contacts..."} value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setSelected(commands.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length : 0); }
            else if (event.key === "Enter" && current) { event.preventDefault(); choose(current); }
            else if (event.key === "ArrowRight" && current?.related?.length && event.currentTarget.selectionStart === query.length) { event.preventDefault(); setParent(current); setQuery(""); setSelected(0); }
            else if (event.key === "Backspace" && parent && !query) { event.preventDefault(); setParent(null); setSelected(0); }
          }} />
        <kbd>Esc</kbd>
      </div>
      {parent ? <button type="button" className="ghost small commandBack" onClick={() => { setParent(null); setSelected(0); input.current?.focus(); }}>Back to search</button> : null}
      <div id={listId} className="commandResults" role="listbox" aria-label={parent ? "Record actions" : "Search results"} aria-busy={waiting}>
        {commands.map((command, i) => <div key={`${command.group}:${command.id}`}>
          {i === 0 || commands[i - 1].group !== command.group ? <div className="commandGroup" role="presentation">{command.group}</div> : null}
          <div id={`${listId}-${i}`} role="option" aria-selected={i === index} className={`commandResult${i === index ? " selected" : ""}`}
            onMouseMove={() => setSelected(i)} onClick={() => choose(command)}>
            <ArrowRight size={15} aria-hidden />
            <div className="commandText"><span>{command.label}</span><small>{command.detail}</small></div>
            {command.related?.length ? <button type="button" className="ghost icon small" aria-label={`Actions for ${command.label}`} onClick={(event) => { event.stopPropagation(); setParent(command); setQuery(""); setSelected(0); input.current?.focus(); }}><ChevronRight size={16} /></button> : <span className="commandHint">Enter</span>}
          </div>
        </div>)}
      </div>
      {waiting ? <div className="commandStatus" role="status">Searching records...</div> : null}
      {failed.length ? <div className="commandStatus" role="status">Could not search {failed.join(", ").toLowerCase()}. <button type="button" className="ghost small" onClick={() => setRetry((value) => value + 1)}>Retry</button></div> : null}
      {!commands.length && !waiting ? <div className="commandEmpty">No matches. Try a name, recipient, or resource ID.</div> : null}
      <div className="commandFooter"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span>{current?.related?.length ? <span><kbd>→</kbd> Actions</span> : null}<span className="commandLocation">{pages.find((page) => location.pathname.startsWith(page.to))?.label ?? "Dispatch"}</span></div>
    </div>
  </Modal>;
}
