/**
 * The one-off Google credential check (check-google-credential-types.ts)
 * against fake encrypted connections in an in-memory Mongo.
 *
 * Claims: each stored shape lands in the right class; the output (stdout,
 * stderr and everything the run writes through process streams) holds no
 * private_key, client_email, credential_source path, refresh token or
 * unknown type string; --dry-run decrypts nothing.
 *
 * Every secret below is a made-up sentinel, encrypted with a key that exists
 * only in this file.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const TEST_KEY = crypto.randomBytes(32).toString("hex");
const OTHER_KEY = crypto.randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY = TEST_KEY;

import { encryptString } from "../services/crypto.service";
import { DatabaseConnection } from "../database/models/database-connections";
import { SourceConnection } from "../database/models/source-connections";
import { Workspace } from "../database/models/workspace";
import {
  isCredentialFieldName,
  parseCheckArgs,
  runCheck,
} from "./check-google-credential-types";

const SECRETS = [
  "SENTINEL_PRIVATE_KEY_BODY",
  "sentinel-sa@secret-project.example.com",
  "/etc/SENTINEL_SECRET_PATH",
  "SENTINEL_REFRESH_TOKEN",
  "SENTINEL_UNKNOWN_TYPE",
  "SENTINEL_EXEC_COMMAND",
  "private_key",
  "client_email",
  "credential_source",
  "refresh_token",
];

const goodKey = {
  type: "service_account",
  client_email: "sentinel-sa@secret-project.example.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nSENTINEL_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
};
const externalAccount = {
  type: "external_account",
  audience: "//iam.googleapis.com/sentinel",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://evil.example.net/steal",
  credential_source: { file: "/etc/SENTINEL_SECRET_PATH" },
};
const execSource = {
  type: "service_account",
  client_email: "sentinel-sa@secret-project.example.com",
  private_key:
    "-----BEGIN PRIVATE KEY-----\nSENTINEL_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----\n",
  credential_source: { executable: { command: "SENTINEL_EXEC_COMMAND" } },
};
const foreignTokenUri = {
  ...goodKey,
  token_uri:
    "https://user:pw@collector.evil.example.net:8443/path?q=SENTINEL_PRIVATE_KEY_BODY",
};
const unknownType = {
  type: "SENTINEL_UNKNOWN_TYPE",
  client_email: "sentinel-sa@secret-project.example.com",
};
const authorizedUser = {
  type: "authorized_user",
  client_id: "x",
  refresh_token: "SENTINEL_REFRESH_TOKEN",
};

/** Encrypt the way the model setter does: every string leaf, one by one. */
function enc(value: unknown): unknown {
  if (typeof value === "string") return value ? encryptString(value) : value;
  if (Array.isArray(value)) return value.map(enc);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, enc(v)]),
    );
  }
  return value;
}

/** Capture everything written to the process streams and the console. */
function captureStreams(): { restore(): string } {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    restore() {
      process.stdout.write = out;
      process.stderr.write = err;
      return chunks.join("");
    },
  };
}

async function main(): Promise<void> {
  // Pure helpers.
  assert.equal(isCredentialFieldName("service_account_json"), true);
  assert.equal(isCredentialFieldName("Key-File"), true);
  assert.equal(isCredentialFieldName("api_key"), false);
  assert.deepEqual(parseCheckArgs(["--dry-run"]), { dryRun: true });
  assert.throws(() => parseCheckArgs(["--apply"]));
  assert.throws(() => parseCheckArgs(["--workspace", "nope"]));

  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  try {
    const ws = await Workspace.collection.insertOne({
      name: "Acme Fake Workspace",
    });
    const workspaceId = ws.insertedId;
    const now = new Date("2026-11-01T00:00:00Z");
    const db = (type: string, connection: unknown) => ({
      workspaceId,
      type,
      createdAt: now,
      updatedAt: now,
      name: type,
      connection: enc(connection),
    });
    const src = (type: string, config: unknown) => ({
      workspaceId,
      type,
      createdAt: now,
      updatedAt: now,
      name: type,
      config: enc(config),
    });
    await DatabaseConnection.collection.insertMany([
      db("bigquery", {
        project_id: "p",
        service_account_json: JSON.stringify(goodKey),
      }),
      db("bigquery", {
        project_id: "p",
        service_account_json: JSON.stringify(externalAccount),
      }),
      db("cloudsql-postgres", {
        service_account_json: JSON.stringify(execSource),
      }),
      db("bigquery", {
        project_id: "p",
        service_account_json: JSON.stringify(foreignTokenUri),
      }),
      db("bigquery", {
        project_id: "p",
        service_account_json: JSON.stringify(unknownType),
      }),
      db("bigquery", {
        project_id: "p",
        service_account_json: "{ not json SENTINEL_PRIVATE_KEY_BODY",
      }),
      // Encrypted under another key: cannot be read here.
      {
        ...db("bigquery", { project_id: "p" }),
        connection: {
          project_id: "p",
          service_account_json: (() => {
            process.env.ENCRYPTION_KEY = OTHER_KEY;
            const v = encryptString(JSON.stringify(goodKey));
            process.env.ENCRYPTION_KEY = TEST_KEY;
            return v;
          })(),
        },
      },
      // Not a Google credential: never decrypted for content.
      db("postgresql", { host: "h", password: "SENTINEL_PRIVATE_KEY_BODY" }),
    ]);
    await SourceConnection.collection.insertMany([
      src("gcs", {
        bucket: "b",
        service_account_json: JSON.stringify(goodKey),
      }),
      // Boxed connector: field name is the author's choice.
      src("ws:bigquery", {
        project_id: "p",
        gcp_blob: JSON.stringify(authorizedUser),
      }),
      src("ws:other", {
        note: "plain text",
        api_key: "SENTINEL_PRIVATE_KEY_BODY",
      }),
      src("stripe", { api_key: "SENTINEL_PRIVATE_KEY_BODY" }),
    ]);

    // Full run.
    const lines: string[] = [];
    const errs: string[] = [];
    const cap = captureStreams();
    let summary;
    try {
      summary = await runCheck(
        { dryRun: false },
        { out: l => lines.push(l), err: l => errs.push(l) },
      );
    } finally {
      cap.restore();
    }
    // The class name has_credential_source is output; the JSON key is not.
    const printed = [...lines, ...errs]
      .join("\n")
      .replaceAll("has_credential_source", "CLASS");
    const streamed = cap.restore();
    assert.equal(streamed, "", "nothing may reach process streams besides io");

    for (const secret of SECRETS) {
      assert.ok(!printed.includes(secret), `output leaked ${secret}`);
    }
    // Hostname only: no userinfo, port, path or query.
    assert.ok(printed.includes("collector.evil.example.net"));
    assert.ok(!printed.includes("8443"));
    assert.ok(!printed.includes("pw@"));

    const rows = lines.slice(1).map(l => l.split("\t"));
    const find = (connType: string, cls: string, detail = "") =>
      rows.find(r => r[3] === connType && r[4] === cls && r[5] === detail);
    assert.equal(lines[0].split("\t").length, 11);
    assert.equal(find("bigquery", "ok")?.[7], "1");
    const bad = find("bigquery", "bad_type", "external_account");
    assert.equal(bad?.[6], "yes");
    assert.match(bad![10], /^[0-9a-f]{24}$/);
    assert.equal(find("bigquery", "bad_type", "other")?.[7], "1");
    assert.equal(find("cloudsql-postgres", "has_credential_source")?.[7], "1");
    assert.equal(
      find("bigquery", "bad_token_uri", "collector.evil.example.net")?.[7],
      "1",
    );
    assert.equal(find("bigquery", "unparseable", "invalid_json")?.[7], "1");
    assert.equal(find("bigquery", "undecryptable")?.[7], "1");
    assert.equal(find("gcs", "ok")?.[7], "1");
    assert.equal(find("ws:bigquery", "bad_type", "authorized_user")?.[7], "1");
    assert.equal(find("gcs", "ok")?.[10], "");
    // Non-Google connections do not appear.
    assert.equal(
      rows.some(r => ["postgresql", "stripe", "ws:other"].includes(r[3])),
      false,
    );
    assert.equal(rows[0][1], "Acme Fake Workspace");
    assert.equal(summary.scanned, 12);
    assert.equal(summary.bad, 7);

    // Dry run with no key at all: decrypts nothing, so nothing is undecryptable.
    delete process.env.ENCRYPTION_KEY;
    const dry: string[] = [];
    const dryErr: string[] = [];
    await runCheck(
      { dryRun: true },
      { out: l => dry.push(l), err: l => dryErr.push(l) },
    );
    process.env.ENCRYPTION_KEY = TEST_KEY;
    const dryText = [...dry, ...dryErr].join("\n");
    for (const secret of SECRETS) assert.ok(!dryText.includes(secret));
    assert.ok(!dryText.includes("undecryptable"));
    const dryRows = dry.slice(1).map(l => l.split("\t"));
    assert.ok(dryRows.every(r => r[4] === "candidate"));
    assert.equal(dryRows.find(r => r[3] === "bigquery")?.[7], "6");
    assert.ok(!dryRows.some(r => r[3] === "stripe" || r[3] === "postgresql"));
    assert.ok(dryErr[0].startsWith("DRY RUN"));
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
  console.log("check-google-credential-types: ok");
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
