/**
 * The MCP OAuth consent screen: which client, which workspace, what it may
 * do. Pure (params in, HTML out) so the page is tested without a session.
 *
 * There are no per-permission options: a connected client can do
 * everything the person's workspace role allows (parseMcpOAuthScopes), so
 * the page lists what that is and asks only "this workspace, this client?".
 */
import type { WorkspaceApiKeyScope } from "./api-key-scopes";
import { authPage, escapeHtml, iconSvg } from "./auth-page";

export const AUTHORIZE_PATH = "/api/oauth/mcp/authorize";

export interface ConsentPageParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: readonly WorkspaceApiKeyScope[];
}

export interface ConsentWorkspace {
  id: string;
  name: string;
  role: string;
}

/** Where approving sends the browser, said plainly: the user's trust cue. */
export function describeRedirect(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
        url.hostname,
      );
      return loopback ? `${url.host} (this computer)` : url.host;
    }
    return `${url.protocol}// (an app on this computer)`;
  } catch {
    return redirectUri;
  }
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

const CONSENT_CSS = `
  .lede { margin-bottom: 20px; }
  .client { display: flex; align-items: center; gap: 8px; font-size: 12px;
    color: var(--muted); padding: 10px 12px; border: 1px dashed var(--border); }
  .client .icon { width: 16px; height: 16px; flex: none; color: var(--accent); }
  .client code { font-size: 12px; white-space: nowrap; }
  fieldset { border: 0; padding: 0; margin: 28px 0 0; min-width: 0; }
  legend, .label { display: block; font: 600 11px ui-monospace, monospace;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted);
    padding: 0; margin-bottom: 10px; }
  .ws { display: flex; align-items: center; gap: 12px; padding: 12px;
    border: 1px solid var(--border); margin-bottom: 8px; cursor: pointer;
    font-size: 14px; background: var(--surface); }
  .ws:hover { background: var(--page); }
  .ws:has(input:checked) { border-color: var(--accent); background: var(--tint); }
  .ws input { position: absolute; opacity: 0; pointer-events: none; }
  .ws:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  .avatar { width: 28px; height: 28px; flex: none; display: grid; place-items: center;
    font: 600 13px ui-monospace, monospace; border: 1px solid var(--border);
    background: var(--page); color: var(--ink); }
  .ws:has(input:checked) .avatar { border-color: var(--accent); color: var(--accent); }
  .ws .name { min-width: 0; font-weight: 500; }
  .ws em { margin-left: auto; color: var(--muted); font-style: normal;
    font: 500 11px ui-monospace, monospace; letter-spacing: 0.06em; text-transform: uppercase; }
  .ws .tick { width: 16px; height: 16px; color: var(--accent); visibility: hidden; flex: none; }
  .ws:has(input:checked) .tick { visibility: visible; }
  .perms { list-style: none; margin: 0; padding: 0; }
  .perms li { display: flex; gap: 10px; align-items: flex-start; font-size: 14px;
    line-height: 1.5; padding: 6px 0; }
  .perms .icon { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent); }
  .note { margin: 10px 0 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
  .actions { display: flex; gap: 8px; margin-top: 28px; }
  button { flex: 1; padding: 12px 16px; font: inherit; font-size: 14px;
    font-weight: 500; cursor: pointer; border: 1px solid var(--ink);
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  .allow { background: var(--ink); color: var(--surface); }
  .deny { background: var(--surface); color: var(--ink); }
  button:hover { opacity: 0.85; }
  button[disabled] { cursor: default; opacity: 0.65; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; flex: none;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

// Approving mints the code and round-trips back to the MCP client, which can
// take a moment — show a spinner and lock the form so the click registers
// once. The disable is deferred a tick so the clicked button's name/value is
// still serialized into the POST body.
const SUBMIT_SCRIPT = `<script>
  (function () {
    var form = document.querySelector("form");
    form.addEventListener("submit", function (e) {
      var decision = e.submitter && e.submitter.value;
      setTimeout(function () {
        form.querySelectorAll("button").forEach(function (b) {
          b.disabled = true;
        });
        if (decision === "allow") {
          form.querySelector(".allow").innerHTML =
            '<span class="spinner"></span><span>Connecting…</span>';
        }
      }, 0);
    });
  })();
</script>`;

export function consentPage(input: {
  clientName: string;
  params: ConsentPageParams;
  workspaces: ConsentWorkspace[];
}): string {
  const { clientName, params, workspaces } = input;
  const client = escapeHtml(clientName);
  const hidden = (name: string, value?: string) =>
    value
      ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`
      : "";
  const options = workspaces
    .map(
      (ws, i) => `
      <label class="ws">
        <input type="radio" name="workspace_id" value="${escapeHtml(ws.id)}" ${i === 0 ? "checked" : ""} />
        <span class="avatar" aria-hidden="true">${escapeHtml(initial(ws.name))}</span>
        <span class="name">${escapeHtml(ws.name)}</span>
        <em>${escapeHtml(ws.role)}</em>
        ${iconSvg("check", "tick")}
      </label>`,
    )
    .join("");
  const check = iconSvg("check");

  const body = `<p class="lede"><strong>${client}</strong> wants to connect to a Mako workspace.</p>
  <div class="client">${iconSvg("link")}<span>Approving returns you to <code>${escapeHtml(describeRedirect(params.redirectUri))}</code></span></div>
  <form method="post" action="${AUTHORIZE_PATH}">
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("state", params.state)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("scope", params.scopes.join(" "))}
    <fieldset>
      <legend>Workspace</legend>
      ${options}
    </fieldset>
    <div style="margin-top: 28px">
      <span class="label">This connection can</span>
      <ul class="perms">
        <li>${check}<span>Explore schemas and run read-only queries</span></li>
        <li>${check}<span>Create and edit Mako apps, notebooks and dbt files</span></li>
        <li>${check}<span>Run dbt models and jobs in your warehouse</span></li>
        <li>${check}<span>Create source connections (API keys) and check them</span></li>
      </ul>
      <p class="note">Whatever your role in the workspace you pick allows: a viewer stays read-only.</p>
    </div>
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow"><span class="label-text">Allow access</span></button>
    </div>
  </form>`;

  return authPage({
    title: `Connect ${clientName}`,
    icon: "link",
    heading: `Connect ${clientName}`,
    body,
    footer:
      "Only approve clients you started yourself. You can disconnect it anytime in Mako under Settings → Connect Agents.",
    css: CONSENT_CSS,
    script: SUBMIT_SCRIPT,
  });
}
