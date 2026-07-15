/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_DISABLE_OAUTH?: string; // Set to "true" to disable OAuth (for PR previews)
  readonly VITE_BUILD_ID?: string; // Git SHA injected by CI; "dev" / unset locally
  // Add more env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// GTM dataLayer for analytics
interface Window {
  dataLayer: Array<Record<string, unknown>>;
}
