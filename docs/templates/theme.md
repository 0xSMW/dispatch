# Brand theme tokens

Brand settings control body text, canvas, surface and border colors, one of four email-safe font stacks, font size (14–18), corner radius (0–16), and filled or outline buttons.

Save with `PATCH /brand`. The merged brand must pass 4.5:1 contrast for body text on background and surface, and button text on button. Filled buttons compute black or white text. Outline buttons use the brand color on the surface, so a low-contrast brand color is refused.

`text_color` is the **body** token. `button_text_color` is the computed legacy button/public-page color. Existing `BRAND_TEXT_COLOR` keeps that legacy meaning; confirmation and preferences keep their existing public styling.

Library HTML uses reserved `THEME_TEXT_COLOR`, `THEME_BACKGROUND_COLOR`, `THEME_SURFACE_COLOR`, `THEME_BORDER_COLOR`, `THEME_FONT_FAMILY`, `THEME_FONT_SIZE`, `THEME_RADIUS`, `THEME_BUTTON_STYLE`, `THEME_BUTTON_BACKGROUND`, `THEME_BUTTON_TEXT_COLOR` and `THEME_BUTTON_BORDER`. These names cannot be declared as tenant template variables. Existing tenant variable names and fallbacks are retained.

## Explicit library updates

Changing brand settings does not rewrite installed HTML. On the Brand page, save the settings and choose **Update library templates**, or call `POST /brand/update-library` with full access.

The update locks each installed template and its latest version. Only a latest version still marked as the matching library source receives the current catalog HTML. Edited/custom copies are skipped and listed with their identities and reasons. Missing templates are not installed. Sending address, reply-to, tracking, Marketing intent and existing variable declarations are preserved. Draft copies remain drafts.

The response is `{ "updated": [{ "id", "name", "slug" }], "skipped": [{ "id", "name", "slug", "reason" }] }`. TypeScript uses `dispatch.brand.updateLibrary()`, Go `UpdateLibraryTemplates()`, and Python `update_library_templates()`.

There is one brand theme per tenant. Multiple themes and reusable tenant components are not supported.
