/**
 * Register a Mako GitHub App via GitHub's manifest flow.
 *
 * 1. Serves a local page that auto-submits the App manifest to GitHub.
 * 2. After you click Create, GitHub redirects to localhost with a one-time code.
 * 3. Exchanges the code for app id, slug, PEM, webhook secret, and OAuth client
 *    credentials → writes them to .env (default) or a JSON file.
 *
 * Usage (dev, personal account, writes .env):
 *   node scripts/register-github-app.mjs
 *
 * Usage (prod, org-owned, writes JSON for CI wiring):
 *   BASE_URL=https://app.mako.ai CLIENT_URL=https://app.mako.ai \
 *   GITHUB_APP_NAME="Mako AI" GITHUB_APP_ORG=mako-ai \
 *   GITHUB_APP_PUBLIC=1 GITHUB_APP_OUTPUT_JSON=.secrets/prod-github-app.json \
 *   node scripts/register-github-app.mjs
 *
 * Env overrides: BASE_URL, CLIENT_URL (read from ../.env when present),
 *   GITHUB_APP_NAME, GITHUB_APP_ORG, GITHUB_APP_PUBLIC, GITHUB_APP_OUTPUT_JSON,
 *   GITHUB_APP_CALLBACK_PORT.
 */
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const CALLBACK_PORT = Number(process.env.GITHUB_APP_CALLBACK_PORT || 9876);

function loadEnvFile() {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function upsertEnv(vars) {
  let lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split("\n")
    : [];
  const keys = Object.keys(vars);
  for (const key of keys) {
    const value = vars[key];
    const prefix = `${key}=`;
    const idx = lines.findIndex(l => l.startsWith(prefix));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  fs.writeFileSync(envPath, lines.join("\n"));
}

function pemToEnv(pem) {
  return pem.replace(/\n/g, "\\n");
}

function htmlAttr(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function exchangeCode(code) {
  const res = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Manifest conversion failed (${res.status}): ${body}`);
  }
  return JSON.parse(body);
}

function openUrl(url) {
  try {
    if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
      return true;
    }
    if (process.platform === "linux") {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

const fileEnv = loadEnvFile();
const baseUrl =
  process.env.BASE_URL || fileEnv.BASE_URL || "http://localhost:8080";
const clientUrl =
  process.env.CLIENT_URL || fileEnv.CLIENT_URL || "http://localhost:5173";
const appName = process.env.GITHUB_APP_NAME || "Mako AI (Dev)";
const ownerOrg = process.env.GITHUB_APP_ORG || "";
const outputJson = process.env.GITHUB_APP_OUTPUT_JSON || "";
const isPublic = process.env.GITHUB_APP_PUBLIC === "1";

const manifest = {
  name: appName,
  description:
    "Connect a workspace GitHub repo for apps, consoles, dbt, and skills.",
  url: clientUrl.replace(/\/$/, ""),
  hook_attributes: {
    url: `${baseUrl.replace(/\/$/, "")}/api/github/webhook`,
    active: true,
  },
  redirect_url: `http://localhost:${CALLBACK_PORT}/callback`,
  setup_url: `${baseUrl.replace(/\/$/, "")}/api/github/setup`,
  // With request_oauth_on_install the setup_url becomes unavailable; GitHub
  // routes the user through OAuth and redirects to the callback URL with both
  // `code` and `installation_id`. Point it at /setup so the bind handler still
  // receives everything it needs to verify ownership.
  callback_urls: [`${baseUrl.replace(/\/$/, "")}/api/github/setup`],
  setup_on_update: true,
  public: isPublic,
  default_permissions: {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "write",
  },
  // Note: `installation`/`installation_repositories` are delivered to every
  // App automatically and must NOT be declared here (GitHub rejects them as
  // unsupported default events).
  default_events: ["push", "pull_request"],
  // Required: the /setup callback verifies the installing user actually
  // controls the installation via the user-to-server OAuth `code`. Without
  // this, GitHub never sends a `code` and Mako refuses to bind (anti-IDOR).
  request_oauth_on_install: true,
};

const manifestJson = JSON.stringify(manifest);
// GitHub's documented manifest flow: POST a form with a `manifest` field to the
// new-app endpoint (personal or org). A self-submitting form avoids query
// length/encoding pitfalls of GET-based approaches.
const newAppAction = ownerOrg
  ? `https://github.com/organizations/${ownerOrg}/settings/apps/new`
  : "https://github.com/settings/apps/new";
const state = Math.random().toString(36).slice(2);

const formPage = `<!doctype html><html><body>
<p>Submitting GitHub App manifest for "${htmlAttr(appName)}"…</p>
<form id="f" method="post" action="${htmlAttr(newAppAction)}?state=${state}">
  <input type="hidden" name="manifest" value="${htmlAttr(manifestJson)}">
</form>
<script>document.getElementById('f').submit();</script>
</body></html>`;

console.log("\nMako GitHub App — manifest registration\n");
console.log("App name:   ", appName);
console.log("Owner:      ", ownerOrg ? `org/${ownerOrg}` : "personal account");
console.log("Public:     ", isPublic);
console.log("Webhook URL:", manifest.hook_attributes.url);
console.log("Setup URL:  ", manifest.setup_url);
console.log("Callback:   ", manifest.redirect_url);
console.log("Output:     ", outputJson || ".env");
console.log(
  `\nStarting local form at http://localhost:${CALLBACK_PORT}/ — open it, then click "Create GitHub App".\n`,
);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

  if (url.pathname === "/" || url.pathname === "/start") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(formPage);
    return;
  }

  if (!url.pathname.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Missing code");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    "<html><body><h1>GitHub App registered</h1><p>You can close this tab.</p></body></html>",
  );

  try {
    const app = await exchangeCode(code);
    const pem = app.pem || app.private_key;
    if (!pem || !app.id || !app.slug) {
      throw new Error("Unexpected conversion response — missing id/slug/pem");
    }

    if (outputJson) {
      const outPath = path.isAbsolute(outputJson)
        ? outputJson
        : path.join(rootDir, outputJson);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            id: app.id,
            slug: app.slug,
            html_url: app.html_url,
            owner: app.owner?.login,
            client_id: app.client_id,
            client_secret: app.client_secret,
            webhook_secret: app.webhook_secret,
            pem,
          },
          null,
          2,
        ),
      );
      fs.chmodSync(outPath, 0o600);
      console.log(`\n✓ Wrote credentials JSON to ${outPath}`);
    } else {
      upsertEnv({
        GITHUB_APP_ID: String(app.id),
        GITHUB_APP_SLUG: app.slug,
        GITHUB_APP_PRIVATE_KEY: pemToEnv(pem),
        GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret || "",
        GITHUB_APP_CLIENT_ID: app.client_id || "",
        GITHUB_APP_CLIENT_SECRET: app.client_secret || "",
      });
      console.log("\n✓ Updated .env");
    }

    console.log("  app id:    ", app.id);
    console.log("  slug:      ", app.slug);
    console.log("  owner:     ", app.owner?.login);
    console.log("  client id: ", app.client_id);
    console.log("  html url:  ", app.html_url);
  } catch (error) {
    console.error("\n✗ Failed to exchange manifest code:", error);
  }

  server.close();
  setTimeout(() => process.exit(0), 250);
});

server.listen(CALLBACK_PORT, () => {
  openUrl(`http://localhost:${CALLBACK_PORT}/`);
});
