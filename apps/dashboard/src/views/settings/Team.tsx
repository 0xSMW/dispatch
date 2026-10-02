import { useState, type ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Drawer } from "../../components/Drawer";
import { Facts } from "../../components/Facts";
import { Field, Select } from "../../components/Field";
import { FilterBar } from "../../components/FilterBar";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Table, type Column } from "../../components/Table";
import { Tabs } from "../../components/Tabs";
import { Time } from "../../components/Time";
import { toast } from "../../components/Toast";
import { useFilters } from "../../hooks/useFilters";
import { useList, type ListState } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useAll } from "../../hooks/useResource";
import { ApiError, type Client } from "../../lib/client";
import { listAll } from "../../lib/pages";
import { csv } from "../../lib/utils";
import { passwordError } from "../../shell/ChangePassword";
import { useCan, useClient, useSession } from "../../shell/session";
import type { AuditLog, List, Membership, Role, SessionRow, User } from "../../types";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";

type Dialog = "invite" | "role" | null;

type Confirm = {
  title: string;
  body: string;
  phrase: string;
  action: string;
  run: () => Promise<unknown>;
  done: string;
  after: () => void;
};

/** Members, users, roles, sessions, and the audit log. Ported from IdentityView. */
export function Team() {
  const client = useClient();
  const { session, signOut } = useSession();
  const can = useCan();
  const filters = useFilters(["action"]);
  const members = useList<Membership>("/memberships", {}, { limit: 20 });
  const users = useList<User>("/users", {}, { limit: 20 });
  const roles = useList<Role>("/roles", {}, { limit: 20 });
  const sessions = useList<SessionRow>("/sessions", {}, { limit: 20 });
  const audit = useList<AuditLog>("/audit-logs", filters, { limit: 20 });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [changing, setChanging] = useState<Membership | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [entry, setEntry] = useState<AuditLog | null>(null);
  const close = () => setDialog(null);

  const reactivate = useMutation((user: User) => client.patch(`/users/${user.id}`, { active: true }), {
    success: "User reactivated.",
    onSuccess: () => void users.reload(),
  });

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        actions={
          can ? (
            <button type="button" onClick={() => setDialog("invite")}>
              Invite member
            </button>
          ) : null
        }
      />
      <Tabs tabs={settingsTabs} />

      <Section
        title="Members"
        list={members}
        columns={[
          { header: "Member", cell: (row) => row.email },
          { header: "Name", cell: (row) => row.name },
          { header: "Role", cell: (row) => <Badge value={row.role} variant="neutral" /> },
          { header: "Added", cell: (row) => <Time value={row.created_at} /> },
        ]}
        menu={(row) => (
          <Menu
            items={[
              { label: "Change role", onSelect: () => setChanging(row) },
              "divider",
              {
                label: "Remove",
                danger: true,
                onSelect: () =>
                  setConfirm({
                    title: "Remove member",
                    body: `${row.email} loses access to this team. Their user record stays.`,
                    phrase: row.email,
                    action: "Remove member",
                    run: () => client.delete(`/memberships/${row.id}`),
                    done: "Member removed.",
                    after: () => void members.reload(),
                  }),
              },
            ]}
          />
        )}
      />

      <Section
        title="Users"
        list={users}
        columns={[
          { header: "Email", cell: (row) => row.email },
          { header: "Name", cell: (row) => row.name },
          {
            header: "Status",
            cell: (row) => <Badge value={row.deactivated_at ? "disabled" : "enabled"} label={row.deactivated_at ? "deactivated" : "active"} />,
          },
          { header: "Created", cell: (row) => <Time value={row.created_at} /> },
        ]}
        menu={(row) => (
          <Menu
            items={[
              { label: "Set password", hidden: Boolean(row.deactivated_at), onSelect: () => setResetting(row) },
              { label: "Reactivate", hidden: !row.deactivated_at, onSelect: () => void reactivate.mutate(row) },
              {
                label: "Deactivate",
                danger: true,
                hidden: Boolean(row.deactivated_at),
                onSelect: () =>
                  setConfirm({
                    title: "Deactivate user",
                    body: `${row.email} can no longer sign in. Their sessions stop working.`,
                    phrase: row.email,
                    action: "Deactivate user",
                    run: () => client.delete(`/users/${row.id}`),
                    done: "User deactivated.",
                    after: () => {
                      void users.reload();
                      void members.reload();
                    },
                  }),
              },
            ]}
          />
        )}
      />

      <Section
        title="Roles"
        list={roles}
        action={
          can ? (
            <button type="button" className="secondary small" onClick={() => setDialog("role")}>
              Add role
            </button>
          ) : null
        }
        columns={[
          { header: "Role", cell: (row) => row.name },
          { header: "Permissions", cell: (row) => <span className="mono">{row.permissions.join(", ")}</span> },
          { header: "Created", cell: (row) => <Time value={row.created_at} /> },
        ]}
        menu={(row) => (
          <Menu
            items={[
              {
                label: "Delete",
                danger: true,
                onSelect: () =>
                  setConfirm({
                    title: "Delete role",
                    body: "Members with this role lose its permissions.",
                    phrase: row.name,
                    action: "Delete role",
                    run: () => client.delete(`/roles/${row.id}`),
                    done: "Role deleted.",
                    after: () => void roles.reload(),
                  }),
              },
            ]}
          />
        )}
      />

      <Section
        title="Sessions"
        list={sessions}
        columns={[
          { header: "Email", cell: (row) => row.email },
          {
            header: "Session",
            cell: (row) => (
              <span className="mono dim">
                {row.id}
                {row.id === session?.id ? " (this one)" : ""}
              </span>
            ),
          },
          { header: "Status", cell: (row) => <Badge value={row.revoked_at ? "revoked" : "enabled"} label={row.revoked_at ? "revoked" : "active"} /> },
          { header: "Last used", cell: (row) => <Time value={row.last_used_at} /> },
          { header: "Expires", cell: (row) => <Time value={row.expires_at} /> },
        ]}
        menu={(row) =>
          row.revoked_at ? null : (
            <Menu
              items={[
                {
                  label: "Revoke",
                  danger: true,
                  // Anyone may end their own sessions, a viewer included.
                  read: Boolean(session?.user?.id) && row.user_id === session?.user?.id,
                  onSelect: () =>
                    setConfirm({
                      title: "Revoke session",
                      body: row.id === session?.id ? "This is your session. You will be signed out." : `${row.email} is signed out of this session.`,
                      phrase: "REVOKE",
                      action: "Revoke session",
                      run: () => client.delete(`/sessions/${row.id}`),
                      done: "Session revoked.",
                      after: () => (row.id === session?.id ? signOut() : void sessions.reload()),
                    }),
                },
              ]}
            />
          )
        }
      />

      <Panel title="Audit log">
        <div className="stack">
          <FilterBar search="Filter by action, such as domain" searchParam="action" />
          <Table
            compact
            rows={audit.rows}
            loading={audit.loading}
            error={audit.error}
            onRetry={() => void audit.reload()}
            onRowClick={setEntry}
            empty={<p className="muted">{filters.action ? "No entries match." : "No audit entries yet."}</p>}
            page={audit.page}
            hasMore={audit.hasMore}
            onNext={audit.next}
            onPrevious={audit.previous}
            columns={[
              { header: "Action", cell: (row) => <span className="mono">{row.action}</span> },
              { header: "Actor", cell: (row) => row.actor_email ?? <span className="dim">API key</span> },
              { header: "Target", cell: (row) => <span className="mono dim">{row.target_id ?? ""}</span> },
              { header: "Created", cell: (row) => <Time value={row.created_at} /> },
            ]}
          />
        </div>
      </Panel>

      {dialog === "invite" ? <Invite onClose={close} onDone={() => void Promise.all([users.reload(), members.reload()])} /> : null}
      {dialog === "role" ? <AddRole onClose={close} onDone={roles.reload} /> : null}
      {changing ? <ChangeRole member={changing} onClose={() => setChanging(null)} onDone={members.reload} /> : null}
      {resetting ? <SetPassword user={resetting} onClose={() => setResetting(null)} onDone={sessions.reload} /> : null}
      {confirm ? (
        <ConfirmPhrase
          title={confirm.title}
          body={confirm.body}
          phrase={confirm.phrase}
          action={confirm.action}
          onConfirm={confirm.run}
          onClose={() => setConfirm(null)}
          onDone={() => {
            toast.success(confirm.done);
            confirm.after();
          }}
        />
      ) : null}
      {entry ? (
        <Drawer isOpen title={entry.action} label="Audit entry" onClose={() => setEntry(null)}>
          <div className="stack">
            <Facts
              columns={2}
              items={[
                { label: "Actor", value: entry.actor_email ?? "API key" },
                { label: "When", value: <Time value={entry.created_at} mode="absolute" /> },
                { label: "Target type", value: entry.target_type ?? "" },
                { label: "Target", value: entry.target_id ?? "", copy: true },
                { label: "Request", value: entry.request_id ?? "", copy: true },
                { label: "ID", value: entry.id, copy: true },
              ]}
            />
            <Code value={entry.data ?? {}} language="json" />
          </div>
        </Drawer>
      ) : null}
    </div>
  );
}

function Section<T extends { id: string }>({
  title,
  list,
  columns,
  action,
  menu,
}: {
  title: string;
  list: ListState<T>;
  columns: Array<Column<T>>;
  action?: ReactNode;
  menu?: (row: T) => ReactNode;
}) {
  return (
    <Panel title={title} actions={action}>
      <Table
        compact
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        columns={columns}
        menu={menu}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
      />
    </Panel>
  );
}

/**
 * The user for an invite: a new one, or a former member with that email, given the new password.
 * Removing a member keeps the user, so inviting them again has to find it. The same goes for an
 * invite whose second request failed after the user was created. A current member is refused:
 * an invite must not quietly replace a teammate's password.
 */
export async function inviteUser(client: Client, email: string, name: string, password: string): Promise<User> {
  try {
    return await client.post<User>("/users", { email, name, password });
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
    const users = await listAll<User>(client, "/users");
    const existing = users.data.find((user) => user.email.toLowerCase() === email.toLowerCase());
    if (!existing) throw error;
    if (existing.deactivated_at) throw new Error(`${existing.email} is deactivated. Reactivate them on the Users tab first.`);
    const members = await listAll<Membership>(client, "/memberships");
    if (members.data.some((member) => member.user_id === existing.id)) {
      throw new Error(`${existing.email} is already on the team. Use Set password to give them a new one.`);
    }
    await client.patch(`/users/${existing.id}`, { password });
    return existing;
  }
}

/**
 * Creates or finds the user with a first password, then gives them a role. Dispatch sends no
 * invite email: share the password with them, and they change it from the account menu.
 */
function Invite({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const roles = useAll<Role>("/roles");
  const [form, setForm] = useState({ email: "", name: "", password: "", role_id: "" });
  const { mutate, isLoading } = useMutation(
    async () => {
      const user = await inviteUser(client, form.email.trim(), form.name.trim(), form.password);
      return client.post("/memberships", { user_id: user.id, role_id: form.role_id });
    },
    {
      success: "Member added.",
      onSuccess: () => {
        onDone();
        onClose();
      },
    },
  );

  return (
    <Modal
      isOpen
      title="Invite member"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Invite"
      submitDisabled={!form.email.trim() || !form.name.trim() || !form.password || Boolean(passwordError(form.password)) || !form.role_id}
      submitting={isLoading}
    >
      <div className="form">
        <Field label="Email" type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} required autoFocus />
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          error={passwordError(form.password)}
          hint="12 to 200 characters. They sign in at /login with this email and password."
          required
          autoComplete="new-password"
        />
        <Select
          label="Role"
          value={form.role_id}
          onChange={(role_id) => setForm({ ...form, role_id })}
          placeholder="Choose a role"
          options={(roles.data?.data ?? []).map((role) => ({ value: role.id, label: role.name }))}
          required
          hint="Admin can change anything. Viewer can read everything but change nothing."
        />
      </div>
    </Modal>
  );
}

function ChangeRole({ member, onClose, onDone }: { member: Membership; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const roles = useAll<Role>("/roles");
  const [roleId, setRoleId] = useState(member.role_id);
  const { mutate, isLoading } = useMutation(() => client.post("/memberships", { user_id: member.user_id, role_id: roleId }), {
    success: "Role changed.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      size="small"
      title={`Change role for ${member.email}`}
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitDisabled={!roleId || roleId === member.role_id}
      submitting={isLoading}
    >
      <div className="form">
        <Select
          label="Role"
          value={roleId}
          onChange={setRoleId}
          options={(roles.data?.data ?? []).map((role) => ({ value: role.id, label: role.name }))}
          required
        />
      </div>
    </Modal>
  );
}

/** An admin sets a new password for a teammate who lost theirs. Their sessions end. */
function SetPassword({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  // The API keeps the session that made the change, so setting your own ends only your others.
  const own = useSession().session?.user?.id === user.id;
  const [password, setPassword] = useState("");
  const { mutate, isLoading } = useMutation(() => client.patch(`/users/${user.id}`, { password }), {
    success: "Password set.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      isOpen
      size="small"
      title={`Set password for ${user.email}`}
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitDisabled={!password || Boolean(passwordError(password))}
      submitting={isLoading}
    >
      <div className="form">
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          error={passwordError(password)}
          hint={own ? "12 to 200 characters. Your other sessions end." : "12 to 200 characters. Their open sessions end."}
          required
          autoFocus
          autoComplete="new-password"
        />
      </div>
    </Modal>
  );
}

function AddRole({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [form, setForm] = useState({ name: "", permissions: "full" });
  const { mutate, isLoading } = useMutation(() => client.post("/roles", { name: form.name, permissions: csv(form.permissions) }), {
    success: "Role added.",
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal isOpen title="Add role" onClose={onClose} onSubmit={() => void mutate()} submitLabel="Add" submitting={isLoading}>
      <div className="form">
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required autoFocus />
        <Field
          label="Permissions"
          value={form.permissions}
          onChange={(permissions) => setForm({ ...form, permissions })}
          hint="Separate permissions with commas."
          mono
        />
      </div>
    </Modal>
  );
}
