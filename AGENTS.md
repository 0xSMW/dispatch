We are building a greenfield self-hostable, AWS-native email API and control plane that makes SES feel developer-native rather than building a mail server.

See init.md for the complete strategy.

Use Computer Use > Chrome — NEVER Playwright.

Use the cleanest, simplest naming structure, Rails-style: prefer clear conventional names that can be assumed from context over overly verbose names.

Internal docs (plans, specs, competitor research) stay local: list each one in `.git/info/exclude` and never commit it.

Do not hide UI tables or page sections inside toggles, accordions, or disclosure controls unless the user explicitly requests that behavior. Keep tables and their headings visible directly on the page. Do not introduce collapsible sections as a way to simplify a busy interface.
