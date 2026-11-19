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
  cli,
  classifyBaseUrl,
  runApiBaseUrlReport,
  deps,
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
  assert.deepEqual(parseCheckArgs(["--i-understand-this-decrypts"]), {
    dryRun: false,
  });
  assert.throws(() => parseCheckArgs([]), /--dry-run or/);
  assert.throws(() => parseCheckArgs(["--workspace", "a".repeat(24)]));
  assert.throws(() => parseCheckArgs(["--apply"]));
  assert.throws(() => parseCheckArgs(["--workspace", "nope"]));

  // No flags: usage, exit 2, and nothing is decrypted or connected.
  const realDecrypt = deps.decrypt;
  let decryptCalls = 0;
  deps.decrypt = (v: string) => {
    decryptCalls += 1;
    return realDecrypt(v);
  };
  const usageErr: string[] = [];
  const code = await cli(
    [],
    { out: l => usageErr.push(l), err: l => usageErr.push(l) },
    {
      DATABASE_URL: "mongodb://127.0.0.1:1/never-connected",
    },
  );
  assert.equal(code, 2);
  assert.ok(usageErr.join("\n").includes("Usage:"));
  assert.equal(decryptCalls, 0, "no flags must not decrypt");

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
      // Legacy rows: the whole `connection` stored as a string.
      {
        ...db("bigquery", {}),
        connection: JSON.stringify(
          enc({
            project_id: "p",
            service_account_json: JSON.stringify(externalAccount),
          }),
        ),
      },
      {
        ...db("bigquery", {}),
        connection: encryptString(
          JSON.stringify({
            project_id: "p",
            service_account_json: JSON.stringify(goodKey),
          }),
        ),
      },
      { ...db("mysql", {}), connection: "legacy garbage, not JSON" },
      // Hostile strings in the type and the token_uri host.
      db("bigquery\tTAB\nNEWLINE", {
        service_account_json: JSON.stringify(externalAccount),
      }),
      db("bigquery", {
        service_account_json: JSON.stringify({
          ...goodKey,
          token_uri: "https://bad_host$.example/x",
        }),
      }),
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
    assert.equal(find("bigquery", "ok")?.[7], "2");
    const bad = find("bigquery", "bad_type", "external_account");
    assert.equal(bad?.[6], "yes");
    assert.match(bad![10], /^[0-9a-f]{24},[0-9a-f]{24}$/);
    assert.equal(find("mysql", "string_config_unparsed")?.[7], "1");
    assert.equal(find("bigquery", "bad_token_uri", "other")?.[7], "1");
    assert.equal(
      find("bigquery TAB NEWLINE", "bad_type", "external_account")?.[7],
      "1",
    );
    assert.ok(lines.every(l => l.split("\t").length === 11));
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
    assert.equal(summary.scanned, 17);
    assert.equal(summary.bad, 11);

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
    assert.equal(dryRows.find(r => r[3] === "bigquery")?.[7], "9");
    assert.ok(!dryRows.some(r => r[3] === "stripe" || r[3] === "postgresql"));
    assert.ok(dryErr[0].startsWith("DRY RUN"));

    // ── Second report: api_base_url classes ──
    const urls: Array<[string, string]> = [
      ["https://bigquery.googleapis.com", "google"],
      ["https://bigquery.googleapis.com/", "google"],
      ["https://bigquery.googleapis.com/evil", "other"],
      ["http://bigquery.googleapis.com", "other"],
      ["https://googleapis.com.evil.example", "other"],
      ["", "empty"],
      ["localhost:8080", "loopback"],
      ["http://127.0.0.1:9050/x?token=SECRET", "loopback"],
      ["http://127.8.9.10", "loopback"],
      ["http://[::1]:80", "loopback"],
      ["http://10.1.2.3", "private"],
      ["http://172.16.0.1", "private"],
      ["http://172.32.0.1", "other"],
      ["http://192.168.1.1", "private"],
      ["http://169.254.169.254/latest", "private"],
      ["http://100.64.0.1", "private"],
      ["http://100.128.0.1", "other"],
      ["http://[fd12:3456::1]", "private"],
      ["http://[fe80::1]", "private"],
      ["http://[::ffff:10.0.0.1]", "private"],
      ["http://2130706433", "loopback"],
      ["https://evil.example/path", "other"],
    ];
    for (const [url, want] of urls) {
      assert.equal(classifyBaseUrl(url), want, `class of ${want} case`);
    }
    assert.equal(classifyBaseUrl(undefined), "empty");

    await DatabaseConnection.collection.deleteMany({});
    await SourceConnection.collection.deleteMany({});
    const mk = (type: string, key: "connection" | "config", body: unknown) => ({
      workspaceId,
      type,
      name: type,
      createdAt: now,
      updatedAt: now,
      [key]: enc(body),
    });
    await DatabaseConnection.collection.insertMany([
      mk("bigquery", "connection", { project_id: "p" }),
      mk("bigquery", "connection", { api_base_url: "" }),
      mk("bigquery", "connection", {
        api_base_url: "https://bigquery.googleapis.com",
      }),
      mk("bigquery", "connection", {
        api_base_url: "http://127.0.0.1:9050/x?token=SECRET",
      }),
      mk("bigquery", "connection", { api_base_url: "http://10.0.0.5/priv" }),
      mk("bigquery", "connection", {
        api_base_url: "https://evil.example/path",
      }),
      mk("postgresql", "connection", {
        api_base_url: "https://evil.example/path",
      }),
      { ...mk("bigquery", "connection", {}), connection: "not json at all" },
      {
        ...mk("bigquery", "connection", {}),
        connection: {
          api_base_url: (() => {
            process.env.ENCRYPTION_KEY = OTHER_KEY;
            const v = encryptString("https://evil.example/path");
            process.env.ENCRYPTION_KEY = TEST_KEY;
            return v;
          })(),
        },
      },
    ]);
    await SourceConnection.collection.insertMany([
      mk("ws:bigquery", "config", {
        api_base_url: "http://127.0.0.1:9050/x?token=SECRET",
      }),
      mk("ws:bigquery", "config", { project_id: "p" }),
      mk("stripe", "config", { api_base_url: "https://evil.example/path" }),
    ]);

    const BASE_SECRETS = [
      "127.0.0.1",
      "9050",
      "token=SECRET",
      "SECRET",
      "evil.example",
      "/path",
      "10.0.0.5",
      "googleapis",
      "api_base_url",
    ];
    const baseOut: string[] = [];
    const baseErr: string[] = [];
    decryptCalls = 0;
    const cap2 = captureStreams();
    try {
      await runApiBaseUrlReport(
        { dryRun: false, report: "api-base-url" },
        { out: l => baseOut.push(l), err: l => baseErr.push(l) },
      );
    } finally {
      cap2.restore();
    }
    assert.equal(cap2.restore(), "");
    const baseText = [...baseOut, ...baseErr].join("\n");
    for (const secret of BASE_SECRETS) {
      assert.ok(!baseText.includes(secret), `base-url output leaked ${secret}`);
    }
    const baseRows = baseOut.slice(1).map(l => l.split("\t"));
    assert.ok(baseOut.every(l => l.split("\t").length === 7));
    const bf = (t: string, c: string) =>
      baseRows.find(r => r[3] === t && r[4] === c);
    assert.equal(bf("bigquery", "empty")?.[5], "2");
    assert.equal(bf("bigquery", "google")?.[5], "1");
    assert.equal(bf("bigquery", "loopback")?.[5], "1");
    assert.match(bf("bigquery", "loopback")![6], /^[0-9a-f]{24}$/);
    assert.equal(bf("bigquery", "private")?.[5], "1");
    assert.equal(bf("bigquery", "other")?.[5], "1");
    assert.equal(bf("bigquery", "string_config_unparsed")?.[5], "1");
    assert.equal(bf("bigquery", "undecryptable")?.[5], "1");
    assert.equal(bf("ws:bigquery", "loopback")?.[5], "1");
    assert.equal(bf("ws:bigquery", "empty")?.[5], "1");
    assert.equal(bf("bigquery", "google")?.[6], "", "google rows list no ids");
    // postgresql and stripe never appear.
    assert.ok(!baseRows.some(r => ["postgresql", "stripe"].includes(r[3])));

    // Dry run: candidates by type, no decrypt, no key needed.
    decryptCalls = 0;
    delete process.env.ENCRYPTION_KEY;
    const bdOut: string[] = [];
    const bdErr: string[] = [];
    await runApiBaseUrlReport(
      { dryRun: true, report: "api-base-url" },
      { out: l => bdOut.push(l), err: l => bdErr.push(l) },
    );
    process.env.ENCRYPTION_KEY = TEST_KEY;
    assert.equal(decryptCalls, 0);
    const bdRows = bdOut.slice(1).map(l => l.split("\t"));
    assert.ok(bdRows.every(r => r[4] === "candidate"));
    assert.equal(bdRows.find(r => r[3] === "bigquery")?.[5], "8");
    assert.equal(bdRows.find(r => r[3] === "ws:bigquery")?.[5], "2");
    assert.ok(!bdRows.some(r => ["postgresql", "stripe"].includes(r[3])));
    const bdText = [...bdOut, ...bdErr].join("\n");
    for (const secret of BASE_SECRETS) assert.ok(!bdText.includes(secret));

    // The report needs the decrypt flag like the other mode.
    assert.deepEqual(
      parseCheckArgs(["--dry-run", "--report", "api-base-url"]),
      { dryRun: true, report: "api-base-url" },
    );
    assert.throws(
      () => parseCheckArgs(["--report", "api-base-url"]),
      /--dry-run or/,
    );
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
    deps.decrypt = realDecrypt;
  }
  console.log("check-google-credential-types: ok");
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
