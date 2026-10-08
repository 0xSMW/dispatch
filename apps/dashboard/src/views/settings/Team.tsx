import { useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Code } from "../../components/Code";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Empty } from "../../components/Empty";
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
import { passwordError } from "../../shell/ChangePassword";
import { useCan, useClient, useSession } from "../../shell/session";
import type { AuditLog, Membership, Role, SessionRow, User } from "../../types";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";

type Dialog = "invite" | "role" | null;

/** /users includes its tenant membership, even when the account or role cannot sign in. */
export type TeamPerson = User & {
  membership_id: string | null;
  membership_created_at: string | null;
  role_id: string | null;
  role: string | null;
  role_deleted_at: string | null;
  permissions: string[] | null;
};

export function teamAccess(person: TeamPerson): string {
  if (person.deactivated_at) return "Account deactivated";
  if (!person.membership_id) return "No team access";
  if (person.role_deleted_at || !person.role) return "Role deleted";
  return person.permissions?.some((permission) => permission === "full" || permission === "read") ? "Enabled" : "No permissions";
}

function membership(person: TeamPerson): Membership {
  return { id: person.membership_id ?? "", user_id: person.id, email: person.email, name: person.name,
    role_id: person.role_id ?? "", role: person.role ?? "", created_at: person.membership_created_at ?? person.created_at };
}

type Confirm = {
  title: string;
  body: string;
  phrase: string;
  action: string;
  run: () => Promise<unknown>;
  done: string;
  after: () => void;
};

/** Tenant people and their access, with role management and activity available on demand. */
export function Team() {
  const client = useClient();
  const { session, signOut } = useSession();
  const can = useCan();
  const filters = useFilters(["action"]);
  const users = useList<TeamPerson>("/users", {}, { limit: 20 });
  const roles = useList<Role>("/roles", {}, { limit: 20 });
  const sessions = useList<SessionRow>("/sessions", {}, { limit: 20 });
  const audit = useList<AuditLog>("/audit-logs", filters, { limit: 20 });
  const [managingRoles, setManagingRoles] = useState(false);
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
        actions={<>
          <button type="button" className="secondary" onClick={() => setManagingRoles(true)}>Manage roles</button>
          {can ? <button type="button" onClick={() => setDialog("invite")}>Add member</button> : null}
        </>}
      />
      <Tabs tabs={settingsTabs} />

      <Section
        title="Team"
        plain
        list={users}
        emptyBody="Add someone to give them access to your team."
        columns={[
          { header: "Person", cell: (row) => <span><strong>{row.name}</strong><br />{row.email}</span> },
          { header: "Role", cell: (row) => row.role ? <Badge value={row.role} label={row.role} variant="neutral" /> : <span className="dim">—</span> },
          { header: "Account", cell: (row) => <Badge value={row.deactivated_at ? "disabled" : "enabled"} label={row.deactivated_at ? "Deactivated" : "Active"} /> },
          { header: "Team access", cell: teamAccess },
          { header: "Added", cell: (row) => <Time value={row.membership_created_at ?? row.created_at} /> },
        ]}
        menu={(row) => <Menu items={[
          { label: row.membership_id ? "Change role" : "Restore team access", hidden: Boolean(row.deactivated_at), onSelect: () => setChanging(membership(row)) },
          { label: "Set password", hidden: Boolean(row.deactivated_at), onSelect: () => setResetting(row) },
          { label: "Reactivate account", hidden: !row.deactivated_at, onSelect: () => void reactivate.mutate(row) },
          "divider",
          { label: "Remove from team", danger: true, hidden: !row.membership_id, onSelect: () => setConfirm({
            title: "Remove member", body: `${row.email} loses access to this team. Their user record stays.`,
            phrase: row.email, action: "Remove member", run: () => client.delete(`/memberships/${row.membership_id}`),
            done: "Member removed.", after: () => { void users.reload(); void sessions.reload(); },
          }) },
          { label: "Deactivate account", danger: true, hidden: Boolean(row.deactivated_at), onSelect: () => setConfirm({
            title: "Deactivate user", body: `${row.email} can no longer sign in. Their sessions stop working.`,
            phrase: row.email, action: "Deactivate user", run: () => client.delete(`/users/${row.id}`),
            done: "User deactivated.", after: () => { void users.reload(); void sessions.reload(); },
          }) },
        ]} />}
      />

      {managingRoles && !dialog && !confirm ? <Modal isOpen title="Manage roles" size="large" onClose={() => setManagingRoles(false)}>
      <Section
        title="Roles"
        list={roles}
        emptyBody="Create a role to control what team members can do."
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
                    after: () => { void roles.reload(); void users.reload(); },
                  }),
              },
            ]}
          />
        )}
      />

      </Modal> : null}

      <Section
        title="Sessions"
        list={sessions}
        emptyBody="Sessions show up here when team members sign in."
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
          { header: "Status", cell: (row) => <Badge value={row.revoked_at ? "revoked" : "enabled"} label={row.revoked_at ? "Revoked" : "Active"} /> },
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
          {audit.loading || audit.error || audit.rows.length || audit.page > 1 || filters.action ? <FilterBar search="Filter by action, such as domain" searchParam="action" /> : null}
          <Table
            compact
            rows={audit.rows}
            loading={audit.loading}
            error={audit.error}
            onRetry={() => void audit.reload()}
            onRowClick={setEntry}
            empty={<Empty compact title={filters.action ? "No matching entries" : "No changes logged yet"} body={filters.action ? "Try a different action." : "Changes to your team and settings show up here."} icon={<Inbox size={28} strokeWidth={1.5} />} />}
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


      {dialog === "invite" ? <Invite onClose={close} onDone={() => void users.reload()} /> : null}
      {dialog === "role" ? <AddRole onClose={close} onDone={roles.reload} /> : null}
      {changing ? <ChangeRole member={changing} onClose={() => setChanging(null)} onDone={users.reload} /> : null}
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
  plain = false,
  list,
  columns,
  action,
  emptyAction,
  emptyBody,
  menu,
}: {
  title: string;
  plain?: boolean;
  list: ListState<T>;
  columns: Array<Column<T>>;
  action?: ReactNode;
  emptyAction?: ReactNode;
  emptyBody?: ReactNode;
  menu?: (row: T) => ReactNode;
}) {
  const table = (
      <Table
        compact
        empty={<Empty compact title={`No ${title.toLowerCase()} yet`} body={emptyBody} action={emptyAction ?? action} />}
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
  );
  const actions = list.loading || list.error || list.rows.length || list.page > 1 ? action : null;
  return plain ? (
    <section>
      <div className="panelHeader">
        <h2>{title}</h2>
        {actions ? <div className="toolbar">{actions}</div> : null}
      </div>
      {table}
    </section>
  ) : <Panel title={title} actions={actions}>{table}</Panel>;
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
    if (existing.deactivated_at) throw new Error(`${existing.email} is deactivated. Reactivate their account in Team first.`);
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
      title="Add member"
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitLabel="Add member"
      submitDisabled={roles.loading || Boolean(roles.error) || Boolean(roles.data?.has_more) || !form.email.trim() || !form.name.trim() || !form.password || Boolean(passwordError(form.password)) || !form.role_id}
      submitting={isLoading}
    >
      <div className="form">
        <RoleChoicesStatus roles={roles} />
        <Field label="Email" type="email" value={form.email} onChange={(email) => setForm({ ...form, email })} required autoFocus />
        <Field label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} required />
        <Field
          label="Password"
          type="password"
          value={form.password}
          onChange={(password) => setForm({ ...form, password })}
          error={passwordError(form.password)}
          hint="12 to 200 characters. Share this password with them securely; no invitation email is sent. They sign in at /login and can change it from the account menu."
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
      title={`${member.id ? "Change role for" : "Restore team access for"} ${member.email}`}
      onClose={onClose}
      onSubmit={() => void mutate()}
      submitDisabled={roles.loading || Boolean(roles.error) || Boolean(roles.data?.has_more) || !roleId || (Boolean(member.id) && roleId === member.role_id)}
      submitting={isLoading}
    >
      <div className="form">
        <RoleChoicesStatus roles={roles} />
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
  const { mutate, isLoading } = useMutation(() => client.post("/roles", { name: form.name, permissions: [form.permissions] }), {
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
        <Select
          label="Permissions"
          value={form.permissions}
          onChange={(permissions) => setForm({ ...form, permissions })}
          options={[{ value: "full", label: "Full access" }, { value: "read", label: "Read only" }]}
          hint="Full access can change anything. Read only can view resources and manage their own password and sessions."
        />
      </div>
    </Modal>
  );
}

function RoleChoicesStatus({ roles }: { roles: ReturnType<typeof useAll<Role>> }) {
  if (roles.loading) return <p role="status">Loading roles…</p>;
  if (roles.error) return <div className="stack"><p role="alert">Could not load roles: {roles.error}</p><button type="button" className="secondary" onClick={() => void roles.reload()}>Retry roles</button></div>;
  if (roles.data?.has_more) return <p role="alert">Not all roles could be loaded. Close this dialog and manage roles before continuing.</p>;
  if (!roles.data?.data.length) return <p role="status">No roles yet. Close this dialog and use Manage roles to add one.</p>;
  return null;
}
