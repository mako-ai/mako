import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACP_PROVIDERS } from "./providers";
import { resolveAdapterCommand } from "./resolve-command";

describe("resolveAdapterCommand (cursor)", () => {
  let binDir: string;
  const savedPath = process.env.PATH;
  const savedEnvCommand = process.env.MAKO_ACP_AGENT_COMMAND;
  const savedEnvProvider = process.env.MAKO_ACP_PROVIDER;

  before(() => {
    binDir = mkdtempSync(join(tmpdir(), "mako-acp-resolve-"));
    delete process.env.MAKO_ACP_AGENT_COMMAND;
    delete process.env.MAKO_ACP_PROVIDER;
  });

  after(() => {
    process.env.PATH = savedPath;
    if (savedEnvCommand !== undefined) {
      process.env.MAKO_ACP_AGENT_COMMAND = savedEnvCommand;
    }
    if (savedEnvProvider !== undefined) {
      process.env.MAKO_ACP_PROVIDER = savedEnvProvider;
    }
    rmSync(binDir, { recursive: true, force: true });
  });

  it("launches `cursor-agent acp` when the CLI is on PATH", () => {
    const bin = join(binDir, "cursor-agent");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    process.env.PATH = binDir;

    const launch = resolveAdapterCommand(ACP_PROVIDERS.cursor);
    assert.ok(launch, "cursor-agent on PATH should resolve");
    assert.equal(launch.via, "path");
    assert.equal(launch.command, bin);
    // Cursor CLI speaks ACP via the `acp` subcommand — args must carry it.
    assert.deepEqual(launch.args, ["acp"]);
  });

  it("has no npx fallback (Cursor CLI is not npm-distributed)", () => {
    rmSync(join(binDir, "cursor-agent"), { force: true });
    process.env.PATH = binDir;

    const launch = resolveAdapterCommand(ACP_PROVIDERS.cursor);
    assert.equal(launch, null);
  });

  it("keeps adapter-only binaries argless on PATH resolve", () => {
    const bin = join(binDir, "claude-agent-acp");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    process.env.PATH = binDir;

    const launch = resolveAdapterCommand(ACP_PROVIDERS.claude);
    assert.ok(launch);
    assert.equal(launch.via, "path");
    assert.deepEqual(launch.args, []);
  });
});
