import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronLeft, Code2 } from "lucide-react";
import { dialogOpen, shortcuts } from "../lib/shortcuts";
import type { BadgeVariant } from "./Badge";

export interface PageHeaderProps {
  title: ReactNode;
  /** Small gray label naming the resource type, such as "Email" or "Domain". */
  label?: string;
  /** Icon in a rounded tile, colored by `tone`. Detail pages pass one; list pages usually do not. */
  icon?: ReactNode;
  tone?: BadgeVariant;
  /** Buttons on the right: secondary actions first, primary action last. */
  actions?: ReactNode;
  /** Back link above the title, such as { to: "/domains", label: "Domains" }. */
  back?: { to: string; label: string };
  /** Functional context under the title, such as an active email scope. */
  context?: ReactNode;
  /** Links to public documentation available in this dashboard version. */
  learn?: Array<{ label: string; href: string }>;
}

/** Title row for list and detail pages. */
export function PageHeader({ title, label, icon, tone = "neutral", actions, back, context, learn }: PageHeaderProps) {
  return (
    <header className="pageHeader">
      {back ? (
        <Link className="backLink" to={back.to}>
          <ChevronLeft size={14} />
          {back.label}
        </Link>
      ) : null}
      <div className="pageHeaderRow">
        {icon ? <div className={`tile large ${tone}`}>{icon}</div> : null}
        <div className="pageHeaderText">
          {label ? <div className="typeLabel">{label}</div> : null}
          <h1>{title}</h1>
          {context ? <p className="muted">{context}</p> : null}
        </div>
        <div className="toolbar pageActions">
          <button
            type="button"
            className="ghost small"
            title={`API reference (${shortcuts.api.keys[0]})`}
            onClick={() => {
              // Use the shell's existing shortcut handler, including its session and dialog guards.
              if (!dialogOpen()) document.dispatchEvent(new KeyboardEvent("keydown", { key: shortcuts.api.combo, bubbles: true }));
            }}
          >
            <Code2 size={14} aria-hidden />
            API
          </button>
          {actions}
        </div>
      </div>
      {learn?.length ? (
        <nav className="learnLinks" aria-label="Learn more">
          <span className="muted"><BookOpen size={14} aria-hidden /> Learn</span>
          {learn.map(({ label, href }) => (
            <a key={href} className="learnChip" href={href} target="_blank" rel="noopener noreferrer">{label}</a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

/** Small status-colored icon tile for the first table column. */
export function Tile({ tone = "neutral", children }: { tone?: BadgeVariant; children: ReactNode }) {
  return <span className={`tile ${tone}`}>{children}</span>;
}
