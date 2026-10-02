import { CheckCircle2 } from "lucide-react";

export interface StatusProps {
  ok: boolean;
  text: string;
}

export function Status({ ok, text }: StatusProps) {
  return (
    <div className={ok ? "status ok" : "status"}>
      <CheckCircle2 size={18} />
      <span>{text}</span>
    </div>
  );
}
