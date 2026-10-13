export type Receipt = { raw: string; headers: Record<string, string | string[] | undefined> };

export type Usage = {
  run: string;
  dir: string;
  url: string;
  key: string;
  tenant: string;
  sender: string;
  hook: { url: string; receipts: Receipt[] };
  api(method: string, path: string, body?: unknown, status?: number, token?: string, headers?: Record<string, string>): Promise<any>;
  form(path: string, fields: Record<string, string>, status?: number): Promise<any>;
  sql(query: string, values?: unknown[]): Promise<any[]>;
  command(program: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<string>;
  wait(read: () => Promise<any>, done: (value: any) => boolean, label: string): Promise<any>;
  check(value: unknown, message: string): void;
  clean(path: string): void;
  restart(): Promise<void>;
};
