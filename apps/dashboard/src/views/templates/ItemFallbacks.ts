import { selectedPlaceholder, type Editor, type Placeholder } from "./placeholders";

/** Hidden item defaults belong to the current visual document, not its inspector. */
export class ItemFallbacks {
  readonly fallbacks = { current: new Map<string, string | number>() };
  private occurrences = new Map<string, { from: number; to: number }>();
  private next = 0;

  key(token: Placeholder) {
    for (const [key, range] of this.occurrences) {
      if (range.from === token.from && range.to === token.to) return key;
    }
    const key = String(this.next++);
    this.occurrences.set(key, { from: token.from, to: token.to });
    return key;
  }

  update(editor: Editor, transaction: Editor["state"]["tr"]) {
    if (!transaction.docChanged) return;
    const edited = transaction.getMeta("placeholderEdit") as { from: number; to: number } | undefined;
    for (const [key, range] of this.occurrences) {
      const deliberate = edited?.from === range.from && edited.to === range.to;
      const from = transaction.mapping.mapResult(range.from, deliberate ? -1 : 1);
      const to = transaction.mapping.mapResult(range.to, deliberate ? 1 : -1);
      const token = selectedPlaceholder(editor, { from: from.pos + 2, to: from.pos + 2 });
      if ((!deliberate && (from.deleted || to.deleted)) || !token || token.from !== from.pos ||
          token.to !== to.pos || token.kind !== "value" || token.list === null) {
        this.occurrences.delete(key);
        this.fallbacks.current.delete(key);
      } else {
        this.occurrences.set(key, { from: token.from, to: token.to });
      }
    }
  }

  clear() {
    this.occurrences.clear();
    this.fallbacks.current.clear();
  }
}
