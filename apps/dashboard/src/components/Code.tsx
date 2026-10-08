import type { ReactNode } from "react";
import { Copy } from "./Copy";

export type CodeLanguage = "json" | "html" | "javascript" | "text";

export interface CodeProps {
  /** A string is shown as is. Anything else is pretty-printed as JSON. */
  value: unknown;
  language?: CodeLanguage;
  copy?: boolean;
  /** Shown when `value` is null, undefined, or empty. */
  empty?: ReactNode;
  className?: string;
}

const jsonToken = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const htmlToken = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w:-]*)|([\w:-]+)(=)("[^"]*"|'[^']*')|(\/?>)/g;

const javascriptToken = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(async|await|const|function|return|if|throw|new|true|false|null|undefined)\b|\b(\d+(?:\.\d+)?)\b/g;

/** Splits code into tinted spans. Pure text nodes, never HTML injection. */
export function tint(text: string, language: CodeLanguage): ReactNode[] {
  if (language === "text") return [text];
  const pattern = language === "json" ? jsonToken : language === "javascript" ? javascriptToken : htmlToken;
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (value: string, className?: string) => {
    if (!value) return;
    out.push(className ? <span key={key++} className={className}>{value}</span> : value);
  };
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    push(text.slice(last, start));
    if (language === "javascript") {
      if (match[1]) push(match[1], "tokComment");
      else if (match[2]) push(match[2], "tokString");
      else if (match[3]) push(match[3], "tokLiteral");
      else push(match[4], "tokNumber");
    } else if (language === "json") {
      if (match[1]) {
        push(match[1], match[2] ? "tokKey" : "tokString");
        push(match[2] ?? "");
      } else if (match[3]) push(match[3], "tokLiteral");
      else push(match[4], "tokNumber");
    } else if (match[1]) push(match[1], "tokComment");
    else if (match[2]) push(match[2], "tokTag");
    else if (match[3]) {
      push(match[3], "tokAttr");
      push(match[4]);
      push(match[5], "tokString");
    } else push(match[6], "tokTag");
    last = start + match[0].length;
  }
  push(text.slice(last));
  return out;
}

/** Syntax-tinted, copyable block for JSON, HTML, JavaScript, and plain text. */
export function Code({ value, language, copy = true, empty = null, className = "" }: CodeProps) {
  if (value === null || value === undefined || value === "") return <>{empty}</>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lang = language ?? (typeof value === "string" ? "text" : "json");
  return (
    <div className={`code ${className}`.trim()}>
      {copy ? (
        <div className="codeCopy">
          <Copy value={text} label="Copy code" />
        </div>
      ) : null}
      <pre>
        <code>{tint(text, lang)}</code>
      </pre>
    </div>
  );
}
