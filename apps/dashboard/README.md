# Dashboard

Vite and React 19. Every page is a route in `src/main.tsx`. Read this before you build a page.

```sh
pnpm --filter @dispatchmail/dashboard dev         # http://127.0.0.1:5173
pnpm vitest run apps/dashboard                 # component and hook tests
pnpm --filter @dispatchmail/dashboard typecheck
pnpm --filter @dispatchmail/dashboard build
```

Build settings are read at build time: `VITE_API_URL` (the API's URL, required when the API is on another host than the dashboard, because the public unsubscribe and shared pages have no session to take it from), `VITE_ALLOW_REMOTE_API`, and `VITE_DOCS_URL`.

Sign in at `/login` with a user's email and password. The page trades them for a `sess_` token through `POST /sessions` and keeps only the token and the user, in `sessionStorage`. It asks for the API URL only when the build has no `VITE_API_URL`. A signed-in user changes their password from the account menu. The production host must serve `index.html` for unknown paths.

## Layout

```txt
src/
  main.tsx            the router, nothing else. One route per row of the 5.3 table.
  styles.css          tokens (dark and light) and every class the components use
  types.ts            response shapes: List<T>, Deleted, and one type per resource
  testing.ts          test helpers: h, signIn, mockFetch, callAt, wrapper
  shell/
    Root.tsx          SessionProvider, <Toaster />, the M key
    Shell.tsx         sidebar, top bar, account menu, onboarding banner, <Outlet />, the A and ? keys
    ApiReference.tsx  the API reference drawer, filled from lib/reference.ts
    Shortcuts.tsx     the ? dialog, filled from lib/shortcuts.ts
    session.tsx       SessionProvider, useSession, useClient, useCan, exchange
    ChangePassword.tsx the account menu's password form, passwordError
    Login.tsx         /login
    Onboarding.tsx    banner on /emails, setupSteps, useSetup
    theme.ts          useTheme, toggleTheme, applyTheme (stored as dispatch.theme)
  lib/
    client.ts         makeClient, publicClient, ApiError, withQuery
    time.ts           relativeTime, absoluteTime, isoTime
    utils.ts          form helpers: csv, addresses, parseJson, sendBody, ...
    events.ts         webhook event types, email statuses, domain statuses and regions
    shortcuts.ts      every keyboard shortcut: the combo handlers bind and the text the ? dialog shows
    reference.ts      the API calls behind each route, for the API reference drawer
  hooks/              useList, useResource, useMutation, useFilters, useHotkey, useSelection, useBulkKeys, useDialog
  components/         shared pieces; index.ts re-exports them
  views/
    tabs.ts           route tabs per area (emails, audience, automations, templates, settings)
    <area>/<Page>.tsx one file per route, list and detail split
```

Every route in `main.tsx` has a page. If you need a route that is not there, add one line.

## Data

Every call goes through `useClient()`. Paths have no `/v1` prefix, bodies are flat, and a single resource comes back flat with `object`.

### `useClient(): Client`

```ts
client.get<T>(path, query?)        // query values that are "", null, or undefined are dropped
client.post<T>(path, body?)        // body defaults to {}
client.patch<T>(path, body?)
client.delete<T>(path)
client.upload<T>(path, formData | { field: string | Blob })
```

Each method returns the parsed JSON. A failure throws `ApiError` with `name` (such as `validation_error`), `statusCode`, `message`, `requestId`, and `issues`. A 400 from a schema failure fills `issues` with `{ path, message }` pairs, where `path` points into the body you sent, such as `steps.2.config.template`. The automation editor uses them to put each error on its step card. A network failure is `network_error` with status 0. A 401 signs the user out. Public pages, which have no session, use `publicClient()`.

### `useCan(): boolean`

True when the signed-in user's role has `full`. A viewer's role has `read` and not `full`: the API lets it call `GET` routes, read and change its own account (`GET /me`, `POST /me/password`), and sign out, and refuses everything else with a 403. Check `useCan()` before you show anything that writes: a create button, a row menu, a bulk action, a save or send button, or a settings form. Hide the button, or disable the field.

```tsx
const can = useCan();
<PageHeader title="Topics" actions={can ? <button type="button" onClick={create}>Create topic</button> : null} />
```

`ListPage` drops `actions` and `bulkActions` for a viewer, and `Table` drops `menu` and `selection`, so a list page needs no check of its own. `useBulkKeys` does nothing for a viewer. The template, broadcast, and automation editors open read-only. Detail pages and forms check `useCan()` themselves. The API is the real guard. The hook only keeps a viewer from seeing buttons that would fail.

A session stored by an older build has no permissions. It counts as full until `GET /me` answers, then the stored session picks up the user's role and permissions.

### `useList<T>(path, filters?, { limit?, all? }?)`

Returns `{ rows, hasMore, loading, error, page, next, previous, reload }`. Pages use ID cursors: `next()` sends the last row's id as `after`, `previous()` goes back one page. The default limit is 40. Changing `path` or any filter value returns to page one. Empty filter values are left out of the query. `all: true` reads every page into `rows`, for pickers.

### `useFilters(names): Filters`

Reads URL search params, for example `useFilters(["q", "status"])`. `FilterBar` writes the same params, so filtered lists survive reload and the back button. Pass the result to `useList`.

### `useResource<T>(path | null)`

Returns `{ data, loading, error, reload, setData }`. `null` skips the request. Call `setData` after a write that returns the new object. A new `path` clears `data` at once, so a page never shows the last object under the next one's URL. A failed `reload` of the same path keeps `data` and sets `error`.

### `useAll<T>(path | null)`

Every row of a list endpoint as one `List<T>`, read 100 at a time. Use it for pickers and lookups (segments, topics, templates, roles), where stopping at the first page hides the 101st choice. Bulk actions that send one request per row go through `each()` in `lib/bulk.ts`, which runs them one at a time and waits out a 429.

### Schedule fields

`useWhen(text)` and `whenHint()` in `lib/when.ts` read a typed time or a phrase such as "tomorrow at 9am" in the browser's timezone, show the result, and give the API an exact instant. Do not send a phrase to the API from the dashboard: the API would read it in its own timezone.

### `useMutation(fn, options?)`

Returns `{ mutate, isLoading, error, data, reset }`. `mutate` never throws. Options: `success` (a toast string, or a function of the result), `onSuccess`, `onError`, `onSettled`. Without `onError`, a failure shows `error.message` in a toast. Use it for every write and disable the button with `isLoading`.

### `useHotkey(combo, handler, { enabled?, inInputs? })`

Combos look like `"m"`, `"escape"`, `"mod+enter"`, `"mod+s"`. `mod` is Cmd on Apple and Ctrl elsewhere. Single keys do not fire while focus is in a field.

Bind combos from `shortcuts` in `lib/shortcuts.ts`, such as `useHotkey(shortcuts.save.combo, save)`, so the `?` dialog stays accurate. A new shortcut gets a row there first.

### `useBulkKeys(selection, rowCount, onDelete)`

The list keys: ⌘A selects every row on the page and ⌫ calls `onDelete` while rows are selected. Both do nothing while the user types or a dialog is open. Use it on every list with checkboxes.

### `useSelection(visibleIds)`

Returns `{ ids, count, has, toggle, toggleAll, allSelected, someSelected, clear }`. Ids that leave the page drop out. Pass it to `Table` or `ListPage` as `selection` and pair it with `BulkBar`.

## Components

All in `src/components`, all exported from `components/index.ts`.

| Component | Props | Notes |
|:---|:---|:---|
| `ListPage<T>` | `title`, `actions`, `tabs`, `search` (placeholder, bound to `?q=`), `filters`, `filterExtra`, `list` (from `useList`), `columns`, `rowHref` or `onRowClick`, `menu`, `selection`, `bulkActions`, `empty`, `noun`, `children` | The whole list page. Put the page's modals in `children`. |
| `Table<T>` | `columns: { header, cell(row), key?, className? }[]`, `rows`, `rowKey?`, `loading`, `error`, `onRetry`, `empty`, `onRowClick`, `selection`, `menu(row)`, `page`, `hasMore`, `onNext`, `onPrevious`, `noun`, `compact` | Footer shows when `page` is set. Row clicks skip buttons, links, and inputs. Use `compact` inside panels and drawers. |
| `FilterBar` | `search`, `searchParam`, `filters: { param, label, options, all? }[]`, `children` | Search is debounced 300 ms. |
| `PageHeader` | `title`, `label`, `icon`, `tone`, `actions`, `back: { to, label }`, `description` | `label` and `icon` make it the detail header. |
| `Tile` | `tone`, `children` | The small status-colored icon in a table's first column. |
| `Tabs` | `tabs: { id, label, to?, count? }[]`, `value`, `onChange` | Tabs with `to` are links. Area tabs live in `views/tabs.ts`. |
| `Facts` | `items: { label, value, copy?, mono?, hidden? }[]`, `columns` | `copy: true` puts a string value in a copyable mono chip. |
| `Badge` | `value`, `variant?`, `label?` | Color comes from `statusToVariant(value)`. Underscores show as spaces. |
| `statusToVariant(status)` | | `success`, `danger`, `warning`, `info`, `accent`, or `neutral`. Handles event types (`email.bounced`) and HTTP codes. `sent` is gray. |
| `Copy` | `value`, `chip?`, `display?`, `label?` | Icon button, or a mono chip with `chip`. |
| `Time` | `value`, `mode: "relative" \| "absolute"` | Relative on lists ("5d ago"), absolute on timelines. The other form shows on hover. |
| `Modal` | `isOpen`, `onClose`, `title`, `onSubmit`, `submitLabel`, `submitDisabled`, `submitting`, `danger`, `size`, `actions` | With `onSubmit` the body is a form and the footer reads "Cancel Esc" and "Save ⌘↵". Focus is trapped. Esc closes the topmost dialog only. |
| `ConfirmPhrase` | `title`, `body`, `phrase`, `action`, `onConfirm`, `onClose`, `onDone` | Use for every delete. Render it only while open. `onDone` runs after success. |
| `Drawer` | `isOpen`, `onClose`, `title`, `label`, `actions`, `width` | Right side panel, same keys as `Modal`. |
| `toast(message, variant?)` | | Also `toast.success` and `toast.error`. Short past tense: "Domain deleted." |
| `Menu` | `items: ({ label, onSelect, icon?, hint?, danger?, disabled?, hidden? } \| "divider")[]`, `label`, `trigger`, `align`, `placement` | The "…" menu. |
| `Code` | `value`, `language: "json" \| "html" \| "text"`, `copy`, `empty` | Non-strings print as JSON. |
| `EmailFrame` | `html`, `width: "desktop" \| "phone"` | The only way to show email HTML. Never loosen its `sandbox`, never use `dangerouslySetInnerHTML`. |
| `EventTimeline` | `events: { label, status?, time, icon?, detail?, variant? }[]`, `empty` | Horizontal nodes with label pills and absolute times. |
| `Skeleton` | `lines`, `width: "short" \| "medium" \| "full"` | |
| `Empty`, `Failed` | `title`, `body`, `action` / `message`, `onRetry` | |
| `BulkBar` | `count`, `actions: { label, onClick, hint?, danger? }[]`, `onClear` | Hidden at zero. |
| `Field`, `TextArea`, `Select`, `Switch` | `label`, `value`, `onChange(value)`, `hint`, `error`, `required`, `wide`, plus `type`, `mono`, `rows`, `options`, `placeholder` | Wrap fields in `<div className="form">` or `"form two"`; `wide` spans both columns. A `<fieldset className="form" disabled={!can}>` turns every control in it off for a viewer. |
| `AreaChart`, `BarChart` | `series: { name, points: { x, y }[], tone? }[]`, `threshold?: { y, label? }`, `format?`, `formatX?`, `label` | SVG, no dependency. `BarChart` stacks its series. Tones match badge colors. |
| `Panel` | `title`, `actions`, `children` | A bordered section. |

## A list page

`views/domains/Domains.tsx`, trimmed:

```tsx
export function Domains() {
  const client = useClient();
  const list = useList<Domain>("/domains");
  const [deleting, setDeleting] = useState<Domain | null>(null);

  return (
    <ListPage
      title="Domains"
      actions={<Link className="button" to="/domains/add">Add domain</Link>}
      list={list}
      noun="domains"
      rowHref={(row) => `/domains/${row.id}`}
      empty={<Empty title="No domains" body="Add a domain to send from your own address." />}
      columns={[
        { header: "Domain", cell: (row) => <span className="cellMain"><Tile tone={statusToVariant(row.status)}><Globe2 size={14} /></Tile>{row.name}</span> },
        { header: "Status", cell: (row) => <Badge value={row.status} /> },
        { header: "Created", cell: (row) => <Time value={row.created_at} /> },
      ]}
      menu={(row) => <Menu items={[{ label: "Delete", danger: true, onSelect: () => setDeleting(row) }]} />}
    >
      {deleting ? (
        <ConfirmPhrase
          title="Delete domain"
          body={`Emails can no longer be sent from ${deleting.name}.`}
          phrase={deleting.name}
          action="Delete domain"
          onConfirm={() => client.delete(`/domains/${deleting.id}`)}
          onClose={() => setDeleting(null)}
          onDone={() => { toast.success("Domain deleted."); void list.reload(); }}
        />
      ) : null}
    </ListPage>
  );
}
```

For filters, read them with `useFilters(["q", "status"])`, pass them to `useList`, and give `ListPage` a `search` placeholder and a `filters` list. `views/emails/Emails.tsx` does this.

A create form is a small component rendered in `children` while open. It uses `Modal` with `onSubmit` and `useMutation`. `CreateKey` in `views/keys/Keys.tsx` is the pattern.

## A detail page

`views/domains/Domain.tsx`, trimmed:

```tsx
export function Domain() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const domain = useResource<DomainRow>(`/domains/${id}`);
  const verify = useMutation(() => client.post(`/domains/${id}/verify`), {
    success: "Verification started.",
    onSuccess: () => domain.reload(),
  });

  if (domain.error) return <Failed message={domain.error} onRetry={domain.reload} />;
  const row = domain.data;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/domains", label: "Domains" }}
        icon={<Globe2 size={20} />}
        tone={row ? statusToVariant(row.status) : "neutral"}
        label="Domain"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={<button type="button" className="secondary" onClick={() => void verify.mutate()}>Verify DNS</button>}
      />
      {row ? <Facts items={[{ label: "Status", value: <Badge value={row.status} /> }, { label: "ID", value: row.id, copy: true }]} /> : <Skeleton lines={2} />}
      <Panel title="DNS records">
        <Table compact rows={row?.records ?? []} loading={domain.loading} columns={[/* ... */]} />
      </Panel>
    </div>
  );
}
```

A nested list on a detail page, such as webhook deliveries, is a second `useList` rendered in a `Table` with `page`, `hasMore`, `onNext`, and `onPrevious`. See `views/webhooks/Webhook.tsx`.

## Visual editor and automation canvas

Both sit behind a switch, load their package with a dynamic `import()`, and leave the default view as it was.

The template and broadcast editors have Code and Visual modes (`views/templates/Visual.tsx`, `guard.ts`). The stored format stays HTML. Visual mode is built on `@react-email/editor`, which rebuilds whatever it loads in its own layout, so the rules are strict:

- It opens an empty template, or HTML it wrote itself and reproduces unchanged. Nothing is written until the user edits.
- Hand-written HTML is refused with a one-line reason. When a rebuild would keep every placeholder, link, and image and cost only formatting, the page offers "Convert to visual", which the user confirms.
- HTML that could cover the dashboard (`position`, `z-index`), a link that is not http, https, mailto, tel, or a placeholder, a data image, a script, a frame, or a form is never loaded into it. The editor shows the email's own markup inside the dashboard page, not inside the sandboxed preview.
- Image files and unsafe pasted HTML are stopped before the package sees them. There is no image upload route.
- A read-only broadcast gets no Visual mode.
- `Source` hands the page a `flushRef`. `useDraft({ before })` calls it ahead of every save, so the last quarter second of typing is never missed. `LeaveGuard` asks its `waiting()` when the user leaves, because the draft does not read as dirty until that edit lands.

The automation editor has List and Canvas views (`views/automations/Canvas.tsx`, `Flow.tsx`, `layout.ts`). The canvas is a second view of the same tree. `layout()` is a pure function from the tree to nodes and edges, and every edit goes through the same `StepActions` and `graph.ts` functions the list uses. New step keys get a random suffix, so a key is never reused: a run finds its steps by key.

Neither has been opened in a browser. Layout, pan and zoom, menus, and paste behavior are untested there.

## API reference drawer

`A`, or the API button in the top bar, opens a drawer listing the calls behind the page on screen, with a cURL and a Node.js snippet for each. The data lives in `references` in `lib/reference.ts`, keyed by the route pattern from `main.tsx`. `:id` in a path is replaced with the id in the URL. `lib/reference.test.ts` reads `main.tsx` and fails when a signed-in route has no entry, so a new page needs one. Set `sdk` to null for a call the TypeScript SDK has no method for.

## Naming

- Short, Rails-style names. A list page is the plural (`Domains`), its detail is the singular (`Domain`), and a sub-page adds one word (`DomainAdd`, `TemplateEditor`). The file name matches the export.
- One page per file under `views/<area>/`. Helpers used by one page stay in that file. Move a helper to `components/` once a second page needs it.
- Hooks are `useThing` in `hooks/useThing.ts`. Response types in `types.ts` are named after the resource, without `Row` or `Response` suffixes.
- Class names are camelCase in `styles.css`. Do not add inline `style` objects for colors; they cannot follow the theme. Use the tokens (`--surface`, `--text-muted`, `--primary`, `--danger`, `--warning`, `--info`, `--accent`, and their `-subtle` and `-border` forms). Check any new text and background pair for 4.5 to 1 contrast in both themes.
- Toasts are short and past tense. Empty states say what goes there and how to add one.
- Tests are `*.test.ts` next to the file, with `// @vitest-environment jsdom` for anything that renders. The root vitest config does not pick up `.test.tsx`, so build elements with `h` from `src/testing.ts`. `signIn("sess_test", ["read"])` starts a test as a viewer.
