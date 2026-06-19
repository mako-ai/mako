/**
 * Register a Mako GitHub App via GitHub's manifest flow.
 *
 * 1. Opens (or prints) a pre-filled "New GitHub App" URL.
 * 2. After you click Create, GitHub redirects to localhost with a one-time code.
 * 3. Exchanges the code for app id, slug, PEM, and webhook secret → updates .env.
 *
 * Usage: node scripts/register-github-app.mjs
 * Env overrides: BASE_URL, CLIENT_URL (read from ../../.env when present).
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

const manifest = {
  name: "Mako Transforms (Dev)",
  description:
    "Import dbt projects from GitHub, sync on push, Slim CI on pull requests.",
  url: clientUrl.replace(/\/$/, ""),
  hook_attributes: {
    url: `${baseUrl.replace(/\/$/, "")}/api/github/webhook`,
    active: true,
  },
  redirect_url: `http://localhost:${CALLBACK_PORT}/callback`,
  setup_url: `${baseUrl.replace(/\/$/, "")}/api/github/setup`,
  setup_on_update: true,
  public: false,
  default_permissions: {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "write",
  },
  default_events: ["push", "pull_request", "installation"],
  request_oauth_on_install: false,
};

const manifestJson = JSON.stringify(manifest);
const manifestB64 = Buffer.from(manifestJson, "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

const registerUrl = `https://github.com/settings/apps/new?manifest=${manifestB64}`;

console.log("\nMako GitHub App — manifest registration\n");
console.log("Webhook URL:", manifest.hook_attributes.url);
console.log("Setup URL:  ", manifest.setup_url);
console.log("Callback:   ", manifest.redirect_url);
console.log("\nOpening GitHub (approve sudo if prompted, then click Create)…\n");

const opened = openUrl(registerUrl);
if (!opened) {
  console.log("Open this URL manually:\n", registerUrl, "\n");
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
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

    upsertEnv({
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_SLUG: app.slug,
      GITHUB_APP_PRIVATE_KEY: pemToEnv(pem),
      GITHUB_APP_WEBHOOK_SECRET: app.webhook_secret || "",
    });

    console.log("\n✓ Updated .env with:");
    console.log("  GITHUB_APP_ID=", app.id);
    console.log("  GITHUB_APP_SLUG=", app.slug);
    console.log("  GITHUB_APP_WEBHOOK_SECRET= (set)");
    console.log("  GITHUB_APP_PRIVATE_KEY= (set)");
    console.log("\nNext: restart the API, then in Mako Transforms click Connect GitHub.\n");
  } catch (error) {
    console.error("\n✗ Failed to exchange manifest code:", error);
  }

  server.close();
  setTimeout(() => process.exit(0), 250);
});

server.listen(CALLBACK_PORT, () => {
  console.log(`Listening for callback on http://localhost:${CALLBACK_PORT}/callback …`);
});
