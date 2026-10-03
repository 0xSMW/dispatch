import { Dispatch, type Result } from "@dispatchmail/sdk";
import { resolve } from "./config.js";
import { ApiError } from "./errors.js";
import { retrying } from "./retry.js";
import type { Globals } from "./tty.js";

export const version = "0.1.0";

// The CLI prints API JSON as it comes back, so it types every call loosely.
// Listing each SDK method here still makes typecheck fail when one is missing.
type Call = (...args: any[]) => Promise<Result<any>>;
type Crud = { create: Call; list: Call; get: Call; update: Call; remove: Call };
type Attachments = { list: Call; get: Call };

export type Api = {
  health: Call;
  emails: {
    send: Call;
    get: Call;
    list: Call;
    update: Call;
    cancel: Call;
    share: Call;
    metrics: Call;
    retry: Call;
    events: Call;
    jobs: { list: Call; get: Call };
    attachments: Attachments;
    receiving: { list: Call; get: Call; forward: Call; simulate: Call; attachments: Attachments };
  };
  batch: { send: Call };
  domains: Crud & { verify: Call; doctor: Call };
  apiKeys: { create: Call; list: Call; update: Call; remove: Call };
  webhooks: Crud & {
    rotateSigningSecret: Call;
    test: Call;
    events: { list: Call; get: Call; attempts: Call; replay: Call };
  };
  templates: Crud & {
    publish: Call;
    duplicate: Call;
    render: Call;
    versions: { list: Call; create: Call };
    library: { list: Call; get: Call; install: Call };
  };
  contacts: Crud & {
    activity: Call;
    segments: { list: Call; add: Call; remove: Call };
    topics: { list: Call; update: Call };
    imports: { create: Call; list: Call; get: Call };
  };
  contactProperties: Crud;
  segments: Crud & { contacts: Call };
  topics: Crud;
  suppressions: { add: Call; list: Call; get: Call; remove: Call; batchAdd: Call; batchRemove: Call };
  broadcasts: Crud & {
    send: Call;
    cancel: Call;
    duplicate: Call;
    recipients: Call;
    clickedLinks: Call;
    pause: Call;
    resume: Call;
  };
  automations: Crud & { duplicate: Call; stop: Call; runs: { list: Call; get: Call } };
  events: Crud & { send: Call; fired: { list: Call; get: Call } };
  logs: { list: Call; get: Call; export: Call };
  usage: { get: Call };
  system: { get: Call };
  timeline: { list: Call };
  me: { get: Call };
  setup: { get: Call };
};

export function clientFor(apiKey: string, apiUrl: string): Api {
  const client: Api = new Dispatch({ apiKey, baseUrl: apiUrl, userAgent: `dispatch-cli:${version}` });
  return retrying(client);
}

export function requireClient(globals: Globals): Api {
  const { apiKey, apiUrl } = resolve(globals);
  return clientFor(apiKey, apiUrl);
}

// Turn a Result into its data, or throw so the command fails with the API's error name.
export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending;
  if (result.error) throw new ApiError(result.error);
  return result.data as T;
}
