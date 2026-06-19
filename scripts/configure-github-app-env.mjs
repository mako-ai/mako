/**
 * Write GitHub App credentials into .env (manual path after creating the app in GitHub UI).
 *
 * Usage:
 *   node scripts/configure-github-app-env.mjs \
 *     --app-id 123456 \
 *     --slug mako-transforms-jonas-dev \
 *     --pem ~/.ssh/mako-github-app.pem \
 *     --webhook-secret "$(openssl rand -hex 24)"
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function pemToEnv(pem) {
  return pem.replace(/\n/g, "\\n");
}

function upsertEnv(vars) {
  let lines = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8").split("\n")
    : [];
  for (const [key, value] of Object.entries(vars)) {
    const prefix = `${key}=`;
    const idx = lines.findIndex(l => l.startsWith(prefix));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  fs.writeFileSync(envPath, lines.join("\n"));
}

const args = parseArgs(process.argv);
if (!args["app-id"] || !args.slug || !args.pem) {
  console.error(
    "Usage: node scripts/configure-github-app-env.mjs --app-id ID --slug SLUG --pem PATH [--webhook-secret SECRET]",
  );
  process.exit(1);
}

const pemPath = args.pem.replace(/^~/, process.env.HOME || "");
const pem = fs.readFileSync(pemPath, "utf8");
const webhookSecret =
  args["webhook-secret"] ||
  Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

upsertEnv({
  GITHUB_APP_ID: String(args["app-id"]),
  GITHUB_APP_SLUG: String(args.slug),
  GITHUB_APP_PRIVATE_KEY: pemToEnv(pem),
  GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
});

console.log("Updated .env:");
console.log("  GITHUB_APP_ID=", args["app-id"]);
console.log("  GITHUB_APP_SLUG=", args.slug);
console.log("  GITHUB_APP_WEBHOOK_SECRET=", webhookSecret);
console.log("  GITHUB_APP_PRIVATE_KEY= (from", pemPath, ")");
console.log(
  "\nSet the same webhook secret on the GitHub App settings page if you generated a new one.",
);
