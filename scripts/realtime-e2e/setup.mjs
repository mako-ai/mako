/**
 * One-time provisioning for the realtime-e2e harness. Uses only the API.
 *
 *   node setup.mjs register <email> <password>
 *       → registers the user; fetch the emailed code (printed to the API log
 *         when SendGrid is unconfigured, or read it from Mongo — see README)
 *   node setup.mjs verify <email> <code>
 *       → verifies the email, prints the session token
 *   node setup.mjs provision <session> <mongoConnectionString> <database>
 *       → logs in with the session, creates a workspace + a MongoDB
 *         connection, and writes .env.e2e next to this script
 *
 * If the user already exists, skip straight to `provision` with a session
 * obtained via POST /api/auth/login.
 */
/* eslint-disable no-console -- standalone dev tool, not API code */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.MAKO_E2E_API_URL || "http://localhost:8080";

const [, , cmd, ...args] = process.argv;

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

if (cmd === "register") {
  const [email, password] = args;
  const res = await fetch(`${API}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Realtime E2E" }),
  });
  console.log(await json(res));
  console.log(
    "\nNext: grab the 6-digit verification code (see README) and run:\n" +
      `  node setup.mjs verify ${email} <code>`,
  );
} else if (cmd === "verify") {
  const [email, code] = args;
  const res = await fetch(`${API}/api/auth/verify-email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const session = /auth_session=([^;]+)/.exec(setCookie)?.[1];
  console.log(await json(res));
  console.log(`\nSession token: ${session}`);
  console.log(
    `\nNext:\n  node setup.mjs provision ${session} mongodb://localhost:27018/sampledb?replicaSet=rs0 sampledb`,
  );
} else if (cmd === "provision") {
  const [session, connectionString, database] = args;
  const headers = {
    "content-type": "application/json",
    cookie: `auth_session=${session}`,
  };

  const wsRes = await fetch(`${API}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Realtime E2E" }),
  });
  const ws = await json(wsRes);
  if (!ws.success) throw new Error(`workspace: ${JSON.stringify(ws)}`);
  const wsId = ws.data.id;

  const connRes = await fetch(`${API}/api/workspaces/${wsId}/databases`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "E2E Sample Mongo",
      type: "mongodb",
      connection: { connectionString, database },
    }),
  });
  const conn = await json(connRes);
  if (!conn.success) throw new Error(`connection: ${JSON.stringify(conn)}`);

  const envFile = path.join(here, ".env.e2e");
  fs.writeFileSync(
    envFile,
    [
      `MAKO_E2E_SESSION=${session}`,
      `MAKO_E2E_WORKSPACE_ID=${wsId}`,
      `MAKO_E2E_CONNECTION_ID=${conn.data.id}`,
      "",
    ].join("\n"),
  );
  console.log(`Wrote ${envFile}`);
  console.log({ workspaceId: wsId, connectionId: conn.data.id });
} else {
  console.log(
    "Usage:\n  node setup.mjs register <email> <password>\n  node setup.mjs verify <email> <code>\n  node setup.mjs provision <session> <mongoConnectionString> <database>",
  );
  process.exitCode = 1;
}
