import { useState } from "react";
import { Search } from "lucide-react";
import { webhookEvents } from "../../lib/events";

/** Searchable multi-select of webhook event types, grouped by resource. */
export function EventPicker({ value, onChange }: { value: string[]; onChange: (events: string[]) => void }) {
  const [query, setQuery] = useState("");
  const shown = webhookEvents.filter((event) => event.includes(query.trim().toLowerCase()));
  const groups = [...new Set(shown.map((event) => event.split(".")[0]))];
  const all = webhookEvents.every((event) => value.includes(event));

  return (
    <fieldset className="eventPicker">
      <legend>Events</legend>
      <div className="eventPickerBar">
        <label className="searchBox">
          <Search size={15} aria-hidden />
          <input type="search" aria-label="Search events" placeholder="Search events" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="ghost small" onClick={() => onChange(all ? [] : [...webhookEvents])}>
          {all ? "Clear all" : "Select all"}
        </button>
        <span className="dim">{value.length} selected</span>
      </div>
      {groups.length === 0 ? <p className="dim">No event types match.</p> : null}
      {groups.map((group) => (
        <div key={group} className="checkGrid" role="group" aria-label={group}>
          {shown
            .filter((event) => event.split(".")[0] === group)
            .map((event) => (
              <label key={event} className="check">
                <input
                  type="checkbox"
                  checked={value.includes(event)}
                  onChange={(change) => onChange(change.target.checked ? [...value, event] : value.filter((item) => item !== event))}
                />
                <span className="mono">{event}</span>
              </label>
            ))}
        </div>
      ))}
    </fieldset>
  );
}
