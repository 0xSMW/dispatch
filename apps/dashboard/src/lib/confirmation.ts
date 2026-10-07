import { publicClient } from "./client";
import type { Confirmation, Confirmed } from "../types";

export function confirmationClient() {
  const client = publicClient();
  const path = (token: string) => `/confirm/${encodeURIComponent(token)}`;
  return {
    get: (token: string) => client.get<Confirmation>(path(token)),
    confirm: (token: string) => client.post<Confirmed>(path(token)),
  };
}
