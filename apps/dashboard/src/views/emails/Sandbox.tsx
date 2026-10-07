import { Badge } from "../../components/Badge";

export const sandboxHint = "Sandbox delivery is simulated. No email is sent externally.";

export function Sandbox() {
  return <span title={sandboxHint}><Badge value="Sandbox" variant="info" /></span>;
}
