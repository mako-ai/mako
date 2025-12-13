/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_MUI_LICENSE_KEY: string;
  readonly VITE_DISABLE_OAUTH?: string; // Set to "true" to disable OAuth (for PR previews)
  // Add more env variables as needed
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
