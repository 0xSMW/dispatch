import { useList } from "../../hooks/useList";
import type { ApiKey } from "../../types";

/** API keys as select options, for the API key filter on Emails and Logs. */
export function useKeyOptions() {
  const keys = useList<ApiKey>("/api-keys", {}, { all: true });
  return keys.rows.map((key) => ({ value: key.id, label: key.name }));
}
