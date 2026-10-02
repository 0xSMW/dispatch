import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import type { BadgeVariant } from "./Badge";

export interface PageHeaderProps {
  title: ReactNode;
  /** Small gray label naming the resource type, such as "Email" or "Domain". */
  label?: string;
  /** Icon in a rounded tile, colored by `tone`. Detail pages pass one; list pages usually do not. */
  icon?: ReactNode;
  tone?: BadgeVariant;
  /** Buttons on the right: the primary action first. */
  actions?: ReactNode;
  /** Back link above the title, such as { to: "/domains", label: "Domains" }. */
  back?: { to: string; label: string };
  /** A line under the title. */
  description?: ReactNode;
}

/** Title row for list and detail pages. */
export function PageHeader({ title, label, icon, tone = "neutral", actions, back, description }: PageHeaderProps) {
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
          {description ? <p className="muted">{description}</p> : null}
        </div>
        {actions ? <div className="toolbar pageActions">{actions}</div> : null}
      </div>
    </header>
  );
}

/** Small status-colored icon tile for the first table column. */
export function Tile({ tone = "neutral", children }: { tone?: BadgeVariant; children: ReactNode }) {
  return <span className={`tile ${tone}`}>{children}</span>;
}
