// CSI, OSC, and other ESC sequences, then the remaining C0 and C1 control
// characters except tab and newline.
const escapes = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function safe(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(escapes, "").replace(controls, "");
}
