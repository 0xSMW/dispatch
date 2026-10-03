/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The API's URL: the default on the sign-in page, and where the public pages send requests. */
  readonly VITE_API_URL?: string;
  /** "true" allows an API on another host than the dashboard or localhost. */
  readonly VITE_ALLOW_REMOTE_API?: string;
  /** Public docs directory URL for the top-bar link and version-aware Learn chips. */
  readonly VITE_DOCS_URL?: string;
}
