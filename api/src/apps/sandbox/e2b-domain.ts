/**
 * The E2B domain this API's boxes live on, and the host suffix their dev
 * servers answer on.
 *
 * A box's public origin is `<port>-<sandboxId>.<domain>`. The domain is
 * per region: `e2b.app` for E2B's default (us-west-1) projects,
 * `e2b-juliett.dev` for the EU project. The e2b SDK reads `E2B_DOMAIN` from
 * the environment on its own, so the API calls already follow it. This
 * module is for everything the SDK does not see: Vite's `allowedHosts` in
 * the launcher and the scaffold, and the startup log.
 */

export const DEFAULT_E2B_DOMAIN = "e2b.app";

/** A bare hostname: two or more DNS labels, no scheme, port or path. */
const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `E2B_DOMAIN`, trimmed and lowercased, or `e2b.app` when unset or blank.
 * A value that is not a bare hostname throws: the SDK would send every call
 * there too, so a typo must fail loudly at boot, not as 403s in previews.
 */
export function e2bDomain(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.E2B_DOMAIN?.trim().toLowerCase().replace(/^\.+/, "");
  if (!raw) return DEFAULT_E2B_DOMAIN;
  if (!DOMAIN_RE.test(raw)) {
    throw new Error(
      `E2B_DOMAIN must be a bare hostname such as "${DEFAULT_E2B_DOMAIN}" ` +
        `or "e2b-juliett.dev", got ${JSON.stringify(env.E2B_DOMAIN)}`,
    );
  }
  return raw;
}

/**
 * The Vite `allowedHosts` entry for a box's dev server. The leading dot makes
 * Vite match it as a suffix, which covers `<port>-<sandboxId>.<domain>`
 * without knowing the sandbox id at write time.
 */
export function previewHostSuffix(domain: string = e2bDomain()): string {
  return `.${domain}`;
}

/**
 * Env for every command and shell in a box. Vite 5.4.12+ and 6.0.9+ add
 * this variable to `allowedHosts`, so a `vite` the user or the agent starts
 * from a terminal also accepts the preview origin, whatever the app's
 * committed `vite.config.ts` says. Mako's own launcher sets the host inline.
 */
export function viteAllowedHostEnv(
  domain: string = e2bDomain(),
): Record<string, string> {
  return { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: previewHostSuffix(domain) };
}

/**
 * The boot log line's fields: which E2B region this API talks to. It says
 * only whether a key is set, never any part of the key.
 */
export function e2bStartupInfo(
  env: Record<string, string | undefined> = process.env,
): {
  provider: string;
  domain: string;
  apiHost: string;
  previewHostSuffix: string;
  apiKeySet: boolean;
} {
  const domain = e2bDomain(env);
  return {
    provider: env.APPS_SANDBOX_PROVIDER?.trim() || "e2b",
    domain,
    apiHost: `api.${domain}`,
    previewHostSuffix: previewHostSuffix(domain),
    apiKeySet: !!env.E2B_API_KEY?.trim(),
  };
}
