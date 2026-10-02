export const DEFAULT_API_URL = "http://localhost:3100";
export const DEFAULT_DEV_API_KEY = "sk_local_dispatch_dev_key_change_before_deploy";

export const apiUrl = process.env.API_URL ?? DEFAULT_API_URL;
export const apiKey = process.env.DISPATCH_API_KEY ?? DEFAULT_DEV_API_KEY;
