import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { Badge } from "../../components/Badge";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { CsvExport, type CsvColumn } from "../../components/CsvExport";
import { Copy } from "../../components/Copy";
import { Empty } from "../../components/Empty";
import { Field, Select } from "../../components/Field";
import { ListPage } from "../../components/ListPage";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { Tile } from "../../components/PageHeader";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useClient } from "../../shell/session";
import type { ApiKey, CreatedApiKey, Domain } from "../../types";

const month = 30 * 24 * 60 * 60 * 1000;

export const keyCsv: Array<CsvColumn<ApiKey>> = [
  { header: "id", value: (row) => row.id },
  { header: "name", value: (row) => row.name },
  { header: "token", value: (row) => row.token },
  { header: "permission", value: (row) => row.permission },
  { header: "domain_id", value: (row) => row.domain_id },
  { header: "last_used_at", value: (row) => row.last_used_at },
  { header: "created_at", value: (row) => row.created_at },
];

/** Green when used in the last 30 days, amber when not, gray when never used. */
export function keyTone(key: Pick<ApiKey, "last_used_at">, now = Date.now()) {
  if (!key.last_used_at) return "neutral" as const;
  return now - new Date(key.last_used_at).getTime() > month ? ("warning" as const) : ("success" as const);
}

export const permissions = [
  { value: "full_access", label: "Full access" },
  { value: "sending_access", label: "Sending access" },
];

export function permissionLabel(value: string) {
  return permissions.find((item) => item.value === value)?.label ?? value;
}

export function Keys() {
  const client = useClient();
  const navigate = useNavigate();
  const list = useList<ApiKey>("/api-keys");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [renaming, setRenaming] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  return (
    <ListPage
      title="API keys"
      actions={
        <button type="button" onClick={() => setCreating(true)}>
          Create API key
        </button>
      }
      filterExtra={<CsvExport rows={list.rows} columns={keyCsv} name="api-keys" />}
      list={list}
      noun="keys"
      rowHref={(row) => `/api-keys/${row.id}`}
      empty={<Empty title="No API keys yet" body="Create a key to let your app use the Dispatch API." />}
      columns={[
        {
          header: "Name",
          cell: (row) => (
            <span className="cellMain">
              <Tile tone={keyTone(row)}>
                <Lock size={14} />
              </Tile>
              <Link to={`/api-keys/${row.id}`}>{row.name}</Link>
            </span>
          ),
        },
        { header: "Token", cell: (row) => (row.token ? <span className="mono">{row.token}</span> : null) },
        { header: "Permission", cell: (row) => (row.permission ? <Badge value={permissionLabel(row.permission)} variant="neutral" /> : null) },
        { header: "Last used", cell: (row) => (row.last_used_at ? <Time value={row.last_used_at} /> : <span className="dim">Never</span>) },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => (
        <Menu
          items={[
            { label: "View key", read: true, onSelect: () => navigate(`/api-keys/${row.id}`) },
            { label: "Edit", onSelect: () => setRenaming(row) },
            "divider",
            { label: "Remove", danger: true, onSelect: () => setRevoking(row) },
          ]}
        />
      )}
    >
      {creating ? (
        <CreateKey
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            void list.reload();
          }}
        />
      ) : null}

      {created ? <Token token={created.token} onClose={() => setCreated(null)} /> : null}

      {renaming ? <RenameKey apiKey={renaming} onClose={() => setRenaming(null)} onDone={() => void list.reload()} /> : null}

      {revoking ? (
        <ConfirmPhrase
          title="Remove API key"
          body={`Requests that use ${revoking.name} will fail at once.`}
          phrase={revoking.name}
          action="Remove key"
          onConfirm={() => client.delete(`/api-keys/${revoking.id}`)}
          onClose={() => setRevoking(null)}
          onDone={() => {
            toast.success("API key removed.");
            void list.reload();
          }}
        />
      ) : null}
    </ListPage>
  );
}

/** Shows a new key's token once, with a copy button. */
export function Token({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="API key created"
      actions={
        <button type="button" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        <p className="muted">Copy the key now. You will not see it again.</p>
        <Copy value={token} chip className="wrap" label="Copy key" />
      </div>
    </Modal>
  );
}

function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (key: CreatedApiKey) => void }) {
  const client = useClient();
  const [name, setName] = useState("");
  const [permission, setPermission] = useState("full_access");
  const [domainId, setDomainId] = useState("");
  const domains = useList<Domain>("/domains", {}, { all: true });
  const sending = permission === "sending_access";
  const { mutate, isLoading } = useMutation(
    () =>
      client.post<CreatedApiKey>("/api-keys", {
        name: name.trim(),
        permission,
        ...(sending && domainId ? { domain_id: domainId } : {}),
      }),
    { onSuccess: onCreated },
  );

  return (
    <Modal isOpen title="Create API key" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Create" submitDisabled={!name.trim()} submitting={isLoading}>
      <div className="form">
        <Field label="Name" value={name} onChange={setName} placeholder="Production" required autoFocus hint="Up to 50 characters." />
        <Select
          label="Permission"
          value={permission}
          onChange={setPermission}
          options={permissions}
          hint={sending ? "Can send email and nothing else." : "Can read and change every resource."}
        />
        {sending ? (
          <Select
            label="Domain"
            value={domainId}
            onChange={setDomainId}
            placeholder="All domains"
            options={domains.rows.map((domain) => ({ value: domain.id, label: domain.name }))}
            hint="Limit the key to sending from one domain."
          />
        ) : null}
      </div>
    </Modal>
  );
}

export function RenameKey({ apiKey, onClose, onDone }: { apiKey: Pick<ApiKey, "id" | "name">; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [name, setName] = useState(apiKey.name);
  const { mutate, isLoading } = useMutation(() => client.patch(`/api-keys/${apiKey.id}`, { name: name.trim() }), {
    success: "API key renamed.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal isOpen title="Edit API key" onClose={onClose} onSubmit={() => void mutate()} submitDisabled={!name.trim() || name.trim() === apiKey.name} submitting={isLoading} size="small">
      <div className="form">
        <Field label="Name" value={name} onChange={setName} required autoFocus hint="Up to 50 characters." />
      </div>
    </Modal>
  );
}
