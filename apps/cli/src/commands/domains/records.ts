import { renderRecord } from "../../lib/output.js";
import { renderTable } from "../../lib/table.js";

type Record = { record?: string; type: string; name: string; value: string; status?: string; priority?: number };

// A domain's fields, then its DNS records as a table.
export function showDomain(domain: { records?: Record[] }) {
  const { records, ...rest } = domain;
  renderRecord(rest);
  if (!records?.length) return;
  console.log("");
  console.log(
    renderTable(
      ["Type", "Name", "Value", "Priority", "Status"],
      records.map((record) => [record.type, record.name, record.value, record.priority ?? "", record.status ?? ""]),
    ),
  );
}
