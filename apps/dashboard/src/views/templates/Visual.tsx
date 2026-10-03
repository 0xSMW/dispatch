// The visual editor, built on @react-email/editor. `Source` loads this file with a
// dynamic import, so the editor package stays out of the main bundle.
//
// The stored format is HTML that the API fills at send time. The package rebuilds whatever it loads
// in its own layout, so the rule here is strict: visual mode opens an empty template, or HTML it
// wrote itself and reproduces unchanged. Anything else is refused. When the only cost of opening it
// would be formatting, the page can offer a conversion, which the user has to confirm.
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { EmailEditor, type EmailEditorRef } from "@react-email/editor";
import "@react-email/editor/themes/default.css";
import { toast } from "../../components/Toast";
import { loss, sameMarkup, unsafePaste, unwrap } from "./guard";
import { PlaceholderPanel, type PlaceholderControls } from "./PlaceholderPanel";
import { selectedPlaceholder, type Editor, type Placeholder } from "./placeholders";
import { ItemFallbacks } from "./ItemFallbacks";
import { prepareVisualHtml, serializeVisual } from "./serialization";

const noImages = "Images cannot be pasted or dropped here. Add the image URL in Code mode.";

// Passing a handler at all is what makes the editor keep `<img>` tags: without it the package has no
// image block and drops them on load. It is never reached, because image files are stopped before
// the package sees them (see `refuseFiles`). Kept at module scope because a new function on each
// render would rebuild the editor.
async function upload(): Promise<{ url: string }> {
  toast(noImages, "danger");
  throw new Error("Image upload is not available.");
}

/** The editor's document as HTML: the copy to store, and both forms the package writes, to compare with. */
async function serialize(ref: EmailEditorRef) {
  if (!ref.editor) return { stored: "", plain: "", formatted: "" };
  return serializeVisual(ref.editor);
}

// Edits are serialized after this many ms of quiet: rendering the email on every keystroke is wasteful.
const quiet = 250;

export type VisualHandle = {
  /** Writes an edit that is still waiting, and resolves once the draft has it. */
  flush: () => Promise<void>;
  /** True while an edit has not reached the draft yet. */
  waiting: () => boolean;
};

export type VisualProps = {
  html: string;
  editable?: boolean;
  /** The user agreed to have hand-written HTML rebuilt in the editor's layout. */
  convert?: boolean;
  /** Gets the editor's HTML after each edit. Not called until the user changes something. */
  onHtml: (html: string) => void;
  /**
   * Called once, with a one-line reason, when the HTML cannot be opened as it is. `convertible`
   * is true when a conversion would keep every placeholder, link, and image, and cost formatting only.
   */
  onReject: (reason: string, convertible: boolean) => void;
  handle?: { current: VisualHandle | null };
  placeholders?: PlaceholderControls;
};

export default function Visual({ html, editable = true, convert = false, onHtml, onReject, handle, placeholders }: VisualProps) {
  // The HTML the editor was loaded with, and a counter that remounts the editor when it changes.
  const [loaded, setLoaded] = useState({ html, version: 0 });
  const content = useMemo(() => prepareVisualHtml(loaded.html), [loaded.html, loaded.version]);
  const [checked, setChecked] = useState(false);
  // The HTML the editor shows now: what it loaded, then what it last wrote.
  const shown = useRef(html);
  const touched = useRef(false);
  const start = useRef("");
  const alive = useRef(true);
  const sequence = useRef(0);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; ref: EmailEditorRef } | null>(null);
  const writing = useRef<Promise<void> | null>(null);
  const callbacks = useRef({ onHtml, onReject });
  callbacks.current = { onHtml, onReject };
  const version = useRef(loaded.version);
  version.current = loaded.version;
  const canEdit = useRef(editable);
  canEdit.current = editable;
  const [selection, setSelection] = useState<{ token: Placeholder; editor: Editor } | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const inspecting = useRef(false);
  const items = useRef(new ItemFallbacks());

  function ready(ref: EmailEditorRef) {
    detach.current?.();
    items.current.clear();
    if (ref.editor) content.restore(ref.editor);
    setSelection(null);
    const editor = ref.editor;
    if (editor && placeholders) {
      const select = ({ transaction }: { transaction: Editor["state"]["tr"] }) => {
        items.current.update(editor, transaction);
        // Browser selection can settle on blur. Keep the token while its panel owns focus.
        if (!transaction.docChanged && (transaction.getMeta("blur") || (!editor.isFocused && !editor.view.hasFocus()))) return;
        if (inspecting.current) {
          if (!transaction.docChanged) return;
          setSelection((current) => {
            if (!current) return null;
            const from = transaction.mapping.map(current.token.from, -1) + 2;
            const token = selectedPlaceholder(editor, { from, to: from });
            return token ? { token, editor } : null;
          });
          return;
        }
        const token = selectedPlaceholder(editor);
        setSelection((current) => {
          if (current?.editor === editor && JSON.stringify(current.token) === JSON.stringify(token)) return current;
          if (!current && !token) return current;
          return token ? { token, editor } : null;
        });
      };
      editor.on("transaction", select);
      detach.current = () => editor.off("transaction", select);
    }
    void check(ref, loaded.version, loaded.html);
  }

  // The HTML changed from outside, for example a restored version or a snippet inserted by the page.
  // The editor reloads it and checks it again.
  useEffect(() => {
    if (html === shown.current) return;
    shown.current = html;
    touched.current = false;
    // Edits still waiting or rendering belong to the old document and must not overwrite the new one.
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    sequence.current += 1;
    setChecked(false);
    setLoaded((current) => ({ html, version: current.version + 1 }));
  }, [html]);

  async function write(ref: EmailEditorRef) {
    // A read-only editor writes nothing, whatever its menus let through.
    if (!canEdit.current) return;
    // The editor can settle its own document after loading. Only a change the user made is written.
    if (!touched.current && JSON.stringify(ref.getJSON()) === start.current) return;
    touched.current = true;
    const id = ++sequence.current;
    const out = await serialize(ref);
    if (id !== sequence.current || !alive.current) return;
    shown.current = out.stored;
    callbacks.current.onHtml(out.stored);
  }

  function track(ref: EmailEditorRef) {
    const run = write(ref).finally(() => {
      if (writing.current === run) writing.current = null;
    });
    writing.current = run;
    return run;
  }

  // The page calls this before it saves, publishes, or leaves visual mode, so the last 250 ms of
  // typing is in the draft first. Without it, typing in Code right after a switch was overwritten
  // by the late write, and a save could miss the last edit.
  async function flush() {
    const last = pending.current;
    if (last) {
      clearTimeout(last.timer);
      pending.current = null;
      await track(last.ref);
    } else if (writing.current) {
      await writing.current;
    }
  }

  useEffect(() => {
    if (handle) handle.current = { flush, waiting: () => Boolean(pending.current || writing.current) };
    return () => {
      if (handle) handle.current = null;
    };
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      // The page flushes before it unmounts this. Anything still waiting here belongs to a page
      // that is going away, and a late write could land on top of what came next.
      alive.current = false;
      detach.current?.();
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
  }, []);

  async function check(ref: EmailEditorRef, loadedVersion: number, source: string) {
    start.current = JSON.stringify(ref.getJSON());
    const out = await serialize(ref);
    // The page may have moved on while the email rendered: Code mode, or newer HTML from outside.
    if (!alive.current || loadedVersion !== version.current) return;
    if (!source.trim()) return setChecked(true);
    const reason = loss(source, out.stored);
    // Its own output, reproduced as it is: nothing changes until the user edits. The stored copy
    // is the formatted one, or the unformatted one when the formatter would have split a tag.
    const own = unwrap(source) !== null && (sameMarkup(source, out.formatted) || sameMarkup(source, out.plain));
    if (!reason && (own || convert)) return setChecked(true);
    callbacks.current.onReject(
      reason ?? "Visual mode would rebuild this HTML in its own layout. Formatting it cannot show, such as colors, widths, and backgrounds, would be lost.",
      !reason,
    );
  }

  function update(ref: EmailEditorRef) {
    if (!checked || !canEdit.current) return;
    if (pending.current) clearTimeout(pending.current.timer);
    const timer = setTimeout(() => {
      pending.current = null;
      void track(ref);
    }, quiet);
    pending.current = { timer, ref };
  }

  // The package puts a pasted or dropped image over the selection first and uploads it after. With
  // no upload route the image is then removed, and whatever was selected has gone with it. So image
  // files, and pasted HTML that carries a data image or a script link, never reach the package.
  function refuse(event: ClipboardEvent | DragEvent, data: DataTransfer | null) {
    if (!data) return;
    const files = [...(data.files ?? [])].some((file) => file.type.startsWith("image/"));
    const markup = data.getData?.("text/html") ?? "";
    if (!files && !(markup && unsafePaste(markup))) return;
    event.preventDefault();
    event.stopPropagation();
    toast(files ? noImages : "That paste holds an image or a link that cannot be stored. Paste it as plain text, or add it in Code mode.", "danger");
  }

  return (
    <div
      className="visual"
      aria-busy={!checked}
      onPasteCapture={(event) => refuse(event, event.clipboardData)}
      onDropCapture={(event) => refuse(event, event.dataTransfer)}
    >
      {checked ? null : (
        <p className="visualCheck" role="status">
          Checking that visual mode keeps this email as it is…
        </p>
      )}
      <div
        className={placeholders && selection && checked ? "visualLayout withPlaceholder" : "visualLayout"}
        onPointerDownCapture={(event) => { inspecting.current = Boolean((event.target as Element).closest(".placeholderPanel")); }}
        onFocusCapture={(event) => { inspecting.current = Boolean((event.target as Element).closest(".placeholderPanel")); }}
      >
        <div className={checked ? "visualCanvas" : "visualCanvas checking"}>
          <EmailEditor
            key={loaded.version}
            content={content.html}
            editable={editable}
            onUploadImage={upload}
            onReady={ready}
            onUpdate={update}
            className="visualDoc"
          />
        </div>
        {checked && placeholders && selection ? <PlaceholderPanel token={selection.token} editor={selection.editor} controls={placeholders} items={items.current} /> : null}
      </div>
    </div>
  );
}
