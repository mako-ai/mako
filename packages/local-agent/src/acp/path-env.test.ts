import assert from "node:assert/strict";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { npmGlobalBinDirs, pathWithNpmGlobals } from "./path-env";

describe("path-env", () => {
  it("includes Homebrew and npm-global bin dirs", () => {
    const dirs = npmGlobalBinDirs();
    assert.ok(dirs.includes("/opt/homebrew/bin"));
    assert.ok(dirs.includes("/usr/local/bin"));
    assert.ok(dirs.includes(join(homedir(), ".npm-global", "bin")));
  });

  it("prepends npm-global dirs ahead of existing PATH", () => {
    const enriched = pathWithNpmGlobals(`/usr/bin${delimiter}/bin`);
    const parts = enriched.split(delimiter);
    assert.equal(parts[parts.length - 2], "/usr/bin");
    assert.equal(parts[parts.length - 1], "/bin");
    assert.ok(parts.includes("/opt/homebrew/bin"));
    assert.ok(parts.indexOf("/opt/homebrew/bin") < parts.indexOf("/usr/bin"));
  });

  it("does not duplicate dirs already on PATH", () => {
    const enriched = pathWithNpmGlobals(`/opt/homebrew/bin${delimiter}/usr/bin`);
    const parts = enriched.split(delimiter);
    assert.equal(parts.filter(p => p === "/opt/homebrew/bin").length, 1);
  });
});
