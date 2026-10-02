# React Email example

`emails/hello.tsx` is a React Email component with two variables, `RECIPIENT_NAME` and `ACTION_URL`. The static `Subject` and `Variables` fields are what `dispatch templates push` reads.

Send the component through the SDK. The SDK renders `react` to HTML before the request leaves the process. `react-email` has to be installed in this project, which it is.

```sh
DISPATCH_API_KEY=re_example pnpm --filter @dispatchmail/example-react-email send
```

Store the same file as a template and publish it.

```sh
pnpm --filter @dispatchmail/cli start -- templates push examples/react-email/emails/hello.tsx --publish
```

`templates push` renders the file twice. The stored HTML keeps `{{{RECIPIENT_NAME}}}` and `{{{ACTION_URL}}}`. A later send by alias fills them. See `examples/python/library.py`.

The subject on the react send is a finished string. The stored template uses `Hello.Subject`, which still contains the placeholder.

The file is `hello.tsx` because push takes the alias from the file name. A file named `welcome.tsx` would overwrite the `welcome` template from the default library.
