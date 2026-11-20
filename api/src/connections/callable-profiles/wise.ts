/**
 * Wise, as a call_connection profile: data only, no connector folder.
 *
 * Restored from the profile merged #1453 removed (`git show
 * d9ea8996d^:api/src/connections/callable.ts`), unchanged. The schema is the
 * deleted connector's getConfigSchema(), which marks `api_key` (password) and
 * `sca_private_key` (encrypted) as secrets.
 */
import { text, trimSlash, type CallableConnection } from "../callable";
import type { CallableProfile } from ".";

const wiseCallable: CallableConnection = {
  type: "wise",
  baseUrl: config =>
    trimSlash(text(config.api_base_url) || "https://api.wise.com"),
  baseUrlFields: ["api_base_url"],
  credential: config => ({ type: "bearer", token: text(config.api_key) }),
  otherSecrets: config => [text(config.sca_private_key)],
};

export const wiseProfile: CallableProfile = {
  type: "wise",
  callable: wiseCallable,
  operations: () => [],
  configSchema: {
    fields: [
      {
        name: "api_key",
        label: "API Token",
        type: "password",
        required: true,
        helperText:
          "Wise personal API token or OAuth access token. Used as `Authorization: Bearer <token>`.",
      },
      {
        name: "profile_id",
        label: "Profile ID",
        type: "string",
        required: false,
        helperText:
          "Optional. Restrict sync to one Wise profile. Leave blank to sync every profile the token can access.",
      },
      {
        name: "sca_private_key",
        label: "SCA Private Key",
        type: "textarea",
        rows: 6,
        encrypted: true,
        required: false,
        helperText:
          "Optional. PEM private key whose public key is registered in Wise (Settings → API tokens → Manage public keys). Wise asks for it (strong customer authentication) before it serves balance statements on some profiles.",
      },
      {
        name: "api_base_url",
        label: "API Base URL",
        type: "string",
        required: false,
        default: "https://api.wise.com",
        helperText:
          "Production: https://api.wise.com. Sandbox: https://api.sandbox.transferwise.tech",
      },
    ],
  },
};
