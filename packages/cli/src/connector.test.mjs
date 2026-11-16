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

test("--remote on a connector file asks about the folder it lives in", async () => {
  const dir = goodFolder({});
  fs.mkdirSync(path.join(dir, "src"));
  fs.renameSync(
    path.join(dir, "connector.ts"),
    path.join(dir, "src", "index.ts"),
  );
  fs.writeFileSync(
    path.join(dir, "connector.yaml"),
    "runtime: node\nentry: src/index.ts\n",
  );
  const slug = path.basename(dir);
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    asked.push(rpc.params.arguments.connector);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ status: "indexed" }) },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await connector(
      { apiUrl: "https://mako.test", apiKey: "revops_test" },
      ["test", path.join(dir, "src", "index.ts")],
      { remote: true },
      { log: () => undefined },
    );
    assert.deepEqual(asked, [`ws:${slug}`]);
  } finally {
    globalThis.fetch = original;
  }
});

/** A fake Mako answering inspect_connector the way the API does. */
function fakeMako(answers) {
  const asked = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    const args = rpc.params.arguments;
    asked.push(args);
    const answer = answers(args);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { asked, restore: () => (globalThis.fetch = original) };
}

function workspaceWithReference(reference = "mako/stripe@1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mako-cli-eject-"));
  fs.mkdirSync(path.join(root, "connectors", "stripe"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "connectors", "stripe", "connector.yaml"),
    `source: ${reference}\n`,
  );
  return root;
}

const PUBLISHED = {
  "connector.yaml": "runtime: node\nentry: connector.ts\n",
  "connector.ts": "export default {};\n",
  "package.json": '{"name":"stripe","version":"1.2.0"}\n',
  "src/lists.ts": "export const x = 1;\n",
};
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
/** What inspect_connector sends: every file base64-encoded. */
const encode = files =>
  Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      name,
      Buffer.from(content).toString("base64"),
    ]),
  );
const release = (version, files = PUBLISHED) => ({
  release: {
    version,
    entry: "connector.ts",
    encoding: "base64",
    files: encode(files),
  },
});

test("eject copies the pinned version's source and drops source:", async () => {
  const root = workspaceWithReference();
  const mako = fakeMako(args =>
    args.connector === "ws:stripe"
      ? {
          status: "verified",
          registry: { ref: "mako/stripe@1", version: "1.2.0" },
        }
      : release("1.2.0", { ...PUBLISHED, "icon.png": ICON }),
  );
  const lines = [];
  try {
    const code = await connector(
      { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
      ["eject", "stripe"],
      {},
      { log: line => lines.push(line) },
    );
    assert.equal(code, 0, lines.join("\n"));
  } finally {
    mako.restore();
  }
  // The version Mako resolved, not the newest, is what gets fetched.
  assert.deepEqual(mako.asked, [
    { connector: "ws:stripe" },
    { connector: "mako/stripe", version: "1.2.0", includeSource: true },
  ]);
  const folder = path.join(root, "connectors", "stripe");
  const yaml = fs.readFileSync(path.join(folder, "connector.yaml"), "utf8");
  assert.doesNotMatch(yaml, /source:/);
  assert.match(yaml, /entry: connector\.ts/);
  assert.equal(
    fs.readFileSync(path.join(folder, "src", "lists.ts"), "utf8"),
    PUBLISHED["src/lists.ts"],
  );
  assert.match(lines.join("\n"), /no longer upgrades/);
  // A binary file arrives byte for byte.
  assert.deepEqual(fs.readFileSync(path.join(folder, "icon.png")), ICON);
});

test("eject refuses a folder that already holds its own code", async () => {
  const root = workspaceWithReference();
  const folder = path.join(root, "connectors", "stripe");
  fs.writeFileSync(path.join(folder, "connector.yaml"), "runtime: node\n");
  const lines = [];
  const code = await connector(
    { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
    ["eject", "stripe"],
    {},
    { log: line => lines.push(line) },
  );
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /Nothing to eject/);
});

test("eject will not overwrite files without --force", async () => {
  const root = workspaceWithReference();
  const folder = path.join(root, "connectors", "stripe");
  fs.writeFileSync(path.join(folder, "connector.ts"), "// mine\n");
  const answers = args =>
    args.connector === "ws:stripe"
      ? { registry: { version: "1.2.0" } }
      : release("1.2.0");
  let mako = fakeMako(answers);
  const lines = [];
  try {
    const refused = await connector(
      { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
      ["eject", "stripe"],
      {},
      { log: line => lines.push(line) },
    );
    assert.equal(refused, 1);
    assert.match(lines.join("\n"), /already holds connector\.ts/);
    assert.equal(
      fs.readFileSync(path.join(folder, "connector.ts"), "utf8"),
      "// mine\n",
    );
  } finally {
    mako.restore();
  }

  mako = fakeMako(answers);
  try {
    const forced = await connector(
      { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
      ["eject", "stripe"],
      { force: true },
      { log: () => undefined },
    );
    assert.equal(forced, 0);
  } finally {
    mako.restore();
  }
  assert.equal(
    fs.readFileSync(path.join(folder, "connector.ts"), "utf8"),
    PUBLISHED["connector.ts"],
  );
});

test("eject with --version skips the lookup, and refuses a path that escapes", async () => {
  const root = workspaceWithReference();
  const mako = fakeMako(() =>
    release("1.0.0", { ...PUBLISHED, "../evil.ts": "x" }),
  );
  const lines = [];
  try {
    const code = await connector(
      { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
      ["eject", "stripe"],
      { version: "1.0.0" },
      { log: line => lines.push(line) },
    );
    assert.equal(code, 1);
  } finally {
    mako.restore();
  }
  assert.equal(mako.asked.length, 1);
  assert.match(lines.join("\n"), /escapes/);
  assert.equal(fs.existsSync(path.join(root, "connectors", "evil.ts")), false);
});

test("eject refuses a dangling symlink in the folder, even with --force", async () => {
  const root = workspaceWithReference();
  const folder = path.join(root, "connectors", "stripe");
  const outside = path.join(
    os.tmpdir(),
    `mako-eject-outside-${process.pid}-${Date.now()}.ts`,
  );
  // Dangling: the target does not exist, so existsSync would say "free".
  fs.symlinkSync(outside, path.join(folder, "connector.ts"));
  const mako = fakeMako(args =>
    args.connector === "ws:stripe"
      ? { registry: { version: "1.2.0" } }
      : release("1.2.0"),
  );
  const lines = [];
  try {
    const code = await connector(
      { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
      ["eject", "stripe"],
      { force: true },
      { log: line => lines.push(line) },
    );
    assert.equal(code, 1);
  } finally {
    mako.restore();
  }
  assert.match(
    lines.join("\n"),
    /connectors\/stripe\/connector\.ts is a symlink/,
  );
  assert.equal(fs.existsSync(outside), false);
});

test("eject refuses a symlinked connector folder", async () => {
  const root = workspaceWithReference();
  const real = path.join(root, "elsewhere");
  fs.renameSync(path.join(root, "connectors", "stripe"), real);
  fs.symlinkSync(real, path.join(root, "connectors", "stripe"));
  const lines = [];
  const code = await connector(
    { apiUrl: "https://mako.test", apiKey: "k", repoRoot: root },
    ["eject", "stripe"],
    {},
    { log: line => lines.push(line) },
  );
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /connectors\/stripe is a symlink/);
});
