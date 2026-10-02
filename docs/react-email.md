# React Email

The TypeScript SDK accepts a `react` field on send, batch, template, and broadcast writes. It renders that value to HTML in the calling process, then deletes `react` before the request is sent. Python and Go do not render React.

Install one renderer next to the code that calls the SDK.

```sh
pnpm add react-email
```

`@react-email/render` works too. If neither package can be imported, the SDK throws `Failed to render React component. Install react-email, or @react-email/render, in your project.`

`examples/react-email/emails/hello.tsx` is a component with two variables. `examples/react-email/send.ts` passes it as `react`.

```sh
DISPATCH_API_KEY=sk_local_dispatch_dev_key_change_before_deploy pnpm --filter @dispatchmail/example-react-email send
```

## Preview while you write

Dispatch has no preview server. React Email's own works without any account.

```sh
npm install react-email react react-dom -E
npm install @react-email/ui -D -E
npx email dev --dir emails
```

The preview opens at `http://localhost:3000`. Its toolbar has a "send test email" button. That button sends through React Email's hosted service, not through your Dispatch. To test through your own install, send the file with the CLI.

```sh
dispatch emails send --react-email emails/hello.tsx --to you@example.com --subject "Welcome"
```

This renders with `--props`, or with the component's `PreviewProps` when `--props` is left out, so the email holds real values.

## Store a file as a template

Push the file. The CLI bundles it with esbuild, renders it with a `{{{KEY}}}` placeholder in place of each declared prop, and writes a draft. `--publish` publishes that version.

```sh
dispatch templates push emails/hello.tsx --publish
dispatch templates push emails --publish
```

The alias is the file name without its extension, so `emails/hello.tsx` becomes `hello`. A file named like one of the sixteen library templates, such as `welcome.tsx`, replaces that library template. Files and folders whose names start with `_` are skipped.

`dispatch templates create --name Hello --react-email emails/hello.tsx` renders the same way: placeholders, not sample values. Pass `--props` to store one fixed render instead. A missing `react-email` import fails with `Install react-email in your project to use --react-email.`

## What the CLI reads from the component

Five static fields. Only `Variables` matters for most files.

- `Subject` is the stored subject. Placeholders are allowed.
- `Variables` lists `{ key, prop, type, fallback_value }`. `prop` is the React prop name. `type` is `string`, `number`, or `list`. A list also gives `fields`, the keys of each item.
- `PreviewProps` holds the sample values used by the preview server and by a send without `--props`.
- `Track` set to `false` turns click and open tracking off for the template. Leave it out to keep the template's current setting. Authentication emails should set it to `false`.
- `Brand` set to `false` stops the CLI from passing a `brand` prop.

## Brand values

Unless `Brand` is `false`, push passes a `brand` prop whose fields are the reserved brand placeholders: `productName` is `{{{PRODUCT_NAME}}}`, `productUrl` is `{{{PRODUCT_URL}}}`, and so on for `logoUrl`, `color`, `textColor`, `supportEmail`, `supportUrl`, `privacyUrl`, `companyName`, `companyAddress`, `year`, and `unsubscribeUrl`. The API fills them from the tenant's brand settings on every send. A component with no `brand` prop ignores it. A component that declares a variable whose `prop` is `brand` keeps its own.

## Lists

A list prop is passed as one sample item whose fields are placeholders. The `Each` component turns that into a `{{{#each KEY}}}` block that the API repeats per item. It is a small file in the template library, which is not published as a package. `dispatch templates eject receipt --dir emails` copies it into your project as `emails/_components/Each.tsx`. A component that calls `.map()` on the prop directly renders one fixed row with no block around it, and the send then fails on the item fields. Use `Each` for any list that a stored template repeats.

## Other languages

After the template is published, `examples/python/library.py` sends by alias. The same alias works from any language. The API never loads React. It fills the stored HTML.
