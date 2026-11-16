/**
 * The conformance command must FAIL on the things that silently break a sync.
 * A test that only proves a good connector passes would not have caught any of
 * the three problems below, each of which is invisible until production.
 */
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connector } from "./connector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(here, "../../connector-sdk/index.js");
const GOOD = path.resolve(here, "../../connector-sdk/fixtures/connector.ts");

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-cli-connector-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

async function runTest(target, flags = {}) {
  const lines = [];
  const code = await connector({}, ["test", target], flags, {
    log: line => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

test("a good connector passes offline, and fully with a credential", async () => {
  const offline = await runTest(GOOD);
  assert.equal(offline.code, 0);
  assert.match(offline.output, /Offline checks passed/);

  const dir = scratch({
    "config.json": JSON.stringify({ apiKey: "good-key" }),
  });
  const full = await runTest(GOOD, { config: path.join(dir, "config.json") });
  assert.equal(full.code, 0, full.output);
  assert.match(full.output, /check: connected/);
  assert.match(full.output, /resumes cleanly/);
});

test("an unmarked secret fails, because it would be stored in plaintext", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "leaky", version: "1.0.0",
        config: { required: ["api_token"], properties: { api_token: { type: "string" } } },
        entities: { rows: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
      });
    `,
  });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /api_token.*not marked/s);
  assert.match(output, /unencrypted/);
});

test("a state that does not advance fails, because the sync would loop forever", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "config.json": JSON.stringify({ apiKey: "x" }),
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "looper", version: "1.0.0",
        config: { properties: {} },
        entities: {
          rows: {
            schema: { id: "string" },
            async *read() { while (true) yield { records: [{ id: "same" }], state: { page: 1 }, hasMore: true }; },
          },
        },
      });
    `,
  });
  const { code, output } = await runTest(dir, {
    config: path.join(dir, "config.json"),
  });
  assert.equal(code, 1);
  assert.match(output, /state does not advance/);
});

test("a declared type the records contradict fails", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "config.json": JSON.stringify({}),
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "liar", version: "1.0.0",
        config: { properties: {} },
        entities: {
          rows: {
            schema: { id: "string", count: "string" },
            async *read() { yield { records: [{ id: "a", count: 7 }], hasMore: false }; },
          },
        },
      });
    `,
  });
  const { code, output } = await runTest(dir, {
    config: path.join(dir, "config.json"),
  });
  assert.equal(code, 1);
  assert.match(output, /count declared string but emitted integer/);
});

test("a folder without connector.yaml is refused, since Mako would never find it", async () => {
  const dir = scratch({ "connector.ts": "export default {};\n" });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /no connector\.yaml/);
});

test("a folder whose connector.yaml names another entry is tested at that entry", async () => {
  // The server runs the file `entry:` names. A gate that only ever looked at
  // connector.ts would refuse a layout production indexes happily.
  const dir = scratch({
    "connector.yaml": "runtime: node\nentry: src/index.ts\n",
  });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src/index.ts"),
    fs.readFileSync(GOOD, "utf8").replace('"../index.js"', JSON.stringify(SDK)),
  );

  const { code, output } = await runTest(dir);
  assert.equal(code, 0, output);
  assert.match(output, /spec: fixture/);
});

test("a spec without declared config properties fails, as the push would", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      const base = defineConnector({
        name: "silent", version: "1.0.0",
        entities: { rows: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
      });
      // A spec that forgot to describe its config at all: the shape that made
      // Mako store credentials unencrypted.
      export default { ...base, spec: () => ({ connectionSpecification: { type: "object" } }) };
    `,
  });

  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /config: \{ properties \}/);
});

/** A good connector folder, written next to the dependency files a test adds. */
function goodFolder(files) {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    ...files,
  });
  fs.writeFileSync(
    path.join(dir, "connector.ts"),
    fs.readFileSync(GOOD, "utf8").replace('"../index.js"', JSON.stringify(SDK)),
  );
  return dir;
}

test("package.json without package-lock.json fails, as the push would refuse it", async () => {
  const dir = goodFolder({ "package.json": '{"dependencies":{}}' });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /package\.json needs package-lock\.json/);
});

test("a pnpm lockfile fails and names the lockfile Mako needs", async () => {
  const dir = goodFolder({
    "package.json": '{"dependencies":{}}',
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /needs package-lock\.json, not pnpm-lock\.yaml/);
});

test("package.json with package-lock.json passes and says Mako bundles it", async () => {
  const dir = goodFolder({
    "package.json": '{"dependencies":{}}',
    "package-lock.json": '{"lockfileVersion":3}',
  });
  const { code, output } = await runTest(dir);
  assert.equal(code, 0, output);
  assert.match(
    output,
    /ok {4}dependencies: package\.json \+ package-lock\.json/,
  );
});

test("a committed node_modules/ fails with the command that fixes it", async () => {
  const dir = goodFolder({
    "package.json": '{"dependencies":{}}',
    "package-lock.json": '{"lockfileVersion":3}',
  });
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "");
  const git = (...args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-f", "node_modules/x/index.js");

  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /node_modules\/ is committed/);
  assert.match(output, /git rm -r --cached/);
});

test("--remote reports Mako's status and a failed build", async () => {
  const dir = goodFolder({});
  const slug = path.basename(dir);
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    asked.push(rpc.params);
    const payload = {
      connector: `ws:${slug}`,
      status: "blocked",
      blockedReason: "Build failed: npm ci failed: 404",
      build: {
        status: "failed",
        hash: "a".repeat(64),
        error: "npm ci failed: 404",
      },
    };
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const lines = [];
    const code = await connector(
      { apiUrl: "https://mako.test", apiKey: "revops_test" },
      ["test", dir],
      { remote: true },
      { log: line => lines.push(line) },
    );
    const output = lines.join("\n");
    assert.equal(code, 1);
    assert.deepEqual(asked, [
      { name: "inspect_connector", arguments: { connector: `ws:${slug}` } },
    ]);
    assert.match(
      output,
      /FAIL {2}mako: ws:.* is blocked, build failed \(a{12}\): npm ci failed: 404/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
