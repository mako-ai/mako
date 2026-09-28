/**
 * The look of every page a sign-in flow shows in a browser: the MCP OAuth
 * consent screen and its error pages here, and the `mako login` loopback
 * confirmation in packages/cli/src/login-page.js.
 *
 * The CLI page cannot import this (it is published on its own and must
 * render offline from the loopback server), so it carries a copy of the same
 * tokens; auth-page.test.ts fails when the two drift. Change a colour here,
 * change it there.
 */

/** Same palette, same names, as packages/cli/src/login-page.js. */
export const AUTH_PAGE_TOKENS = {
  light: {
    page: "#f6f5f1",
    surface: "#fff",
    ink: "#1a1a1a",
    muted: "#555",
    border: "#d8d5cc",
    shadow: "#e3e0d7",
    accent: "#6c4fd8",
    tint: "#f0ecfc",
  },
  dark: {
    page: "#161513",
    surface: "#201e1a",
    ink: "#edeae3",
    muted: "#b8b3a9",
    border: "#55504a",
    shadow: "#302c26",
    accent: "#b7a5ff",
    tint: "#30283e",
  },
} as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokenCss(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(" ");
}

export type AuthPageIcon = "check" | "cross" | "alert" | "link";

const ICON_PATHS: Record<AuthPageIcon, string> = {
  check: '<path d="m5 12 4 4L19 6" />',
  cross: '<path d="m6 6 12 12M18 6 6 18" />',
  alert: '<path d="M12 5v9m0 4h.01" />',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />',
};

export function iconSvg(icon: AuthPageIcon, className = "icon"): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[icon]}</svg>`;
}

const BASE_CSS = `
  :root { color-scheme: light; ${tokenCss(AUTH_PAGE_TOKENS.light)} }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { color-scheme: dark; ${tokenCss(AUTH_PAGE_TOKENS.dark)} }
  }
  :root[data-theme="dark"] { color-scheme: dark; ${tokenCss(AUTH_PAGE_TOKENS.dark)} }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100svh; padding: 32px 24px;
    display: flex; align-items: center; justify-content: center;
    background: var(--page); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { width: 100%; max-width: 486px; padding: 32px;
    background: var(--surface); border: 1px solid var(--border);
    box-shadow: 6px 6px 0 var(--shadow); overflow-wrap: anywhere; }
  .brand { font: 600 12px ui-monospace, monospace; letter-spacing: 0.14em;
    margin-bottom: 36px; }
  .status { width: 48px; height: 48px; display: grid; place-items: center;
    margin-bottom: 24px; color: var(--accent); background: var(--tint);
    border: 1px solid var(--accent); }
  .status .icon { width: 24px; height: 24px; }
  h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: -0.035em;
    line-height: 1.2; font-weight: 600; }
  p { margin: 0; font-size: 14px; line-height: 1.7; color: var(--muted); }
  p strong { color: var(--ink); font-weight: 600; }
  .next { margin-top: 28px; padding: 16px; background: var(--page);
    border: 1px solid var(--border); }
  .next strong { display: block; font-size: 13px; margin-bottom: 4px; color: var(--ink); }
  code { font: 13px ui-monospace, monospace; color: var(--ink); }
  footer { border-top: 1px solid var(--border); padding-top: 20px;
    margin-top: 28px; font-size: 12px; line-height: 1.6; color: var(--muted); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  @media (max-width: 480px) { body { padding: 16px; } .card { padding: 24px; } h1 { font-size: 24px; } }
`;

/** Follow the app's explicit light/dark choice before paint (same origin). */
const THEME_SCRIPT = `<script>
  (function () {
    function syncTheme() {
      try {
        var mode = localStorage.getItem("themeMode");
        if (mode === "light" || mode === "dark") {
          document.documentElement.dataset.theme = mode;
        } else {
          delete document.documentElement.dataset.theme;
        }
      } catch (_) { /* The system theme still applies without storage. */ }
    }
    syncTheme();
    window.addEventListener("storage", syncTheme);
  })();
</script>`;

/**
 * One page: brand line, status mark, heading, body, footer. `body` and
 * `footer` are trusted HTML — escape every interpolated value before
 * passing it in.
 */
export function authPage(input: {
  title: string;
  icon: AuthPageIcon;
  heading: string;
  body: string;
  footer: string;
  css?: string;
  script?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(input.title)} — Mako</title>
${THEME_SCRIPT}
<style>${BASE_CSS}${input.css ?? ""}</style>
</head>
<body>
<main class="card">
  <div class="brand">MAKO / CONNECT</div>
  <div class="status">${iconSvg(input.icon)}</div>
  <h1>${escapeHtml(input.heading)}</h1>
  ${input.body}
  <footer>${input.footer}</footer>
</main>
${input.script ?? ""}
</body>
</html>`;
}

/**
 * The flow cannot continue (unknown client, unregistered redirect, not a
 * member…): say why, and what to do next, in the same card as everything
 * else — not a bare heading on a white page.
 */
export function authMessagePage(input: {
  heading: string;
  message: string;
  next: { title: string; body: string };
  icon?: AuthPageIcon;
}): string {
  return authPage({
    title: input.heading,
    icon: input.icon ?? "alert",
    heading: input.heading,
    body: `<p>${escapeHtml(input.message)}</p>
  <div class="next">
    <strong>${escapeHtml(input.next.title)}</strong>
    <p>${escapeHtml(input.next.body)}</p>
  </div>`,
    footer: "You can safely close this tab.",
  });
}
