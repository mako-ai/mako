/**
 * The package-manager detection is shell evaluated in the sandbox, so it is
 * tested the same way: run it with bash in a real folder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEPENDS_ON_MAKO_PACKAGES,
  INSTALL_IS_FRESH,
  IS_PNPM_APP,
  installCommand,
  updateMakoPackagesCommand,
} from "./package-manager";

function appDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-pm-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function succeeds(cwd: string, test: string): boolean {
  return spawnSync("bash", ["-c", test], { cwd }).status === 0;
}

function touch(dir: string, name: string, secondsAgo: number): void {
  const at = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(path.join(dir, name), at, at);
}

const pkg = (extra: object = {}) =>
  JSON.stringify({ name: "app", ...extra }, null, 2);

// Detection: the lockfile, then the packageManager field, else npm.
assert.equal(
  succeeds(
    appDir({ "package.json": pkg(), "pnpm-lock.yaml": "" }),
    IS_PNPM_APP,
  ),
  true,
);
assert.equal(
  succeeds(
    appDir({ "package.json": pkg({ packageManager: "pnpm@10.33.3" }) }),
    IS_PNPM_APP,
  ),
  true,
  "a new app has no lockfile yet; its packageManager field decides",
);
assert.equal(
  succeeds(
    appDir({ "package.json": pkg(), "package-lock.json": "{}" }),
    IS_PNPM_APP,
  ),
  false,
);
assert.equal(
  succeeds(appDir({ "package.json": pkg() }), IS_PNPM_APP),
  false,
  "no lockfile stays npm",
);
assert.equal(
  succeeds(
    appDir({ "package.json": pkg({ packageManager: "yarn@4.0.0" }) }),
    IS_PNPM_APP,
  ),
  false,
);
assert.equal(
  succeeds(
    appDir({
      "package.json": pkg(),
      "pnpm-lock.yaml": "",
      "package-lock.json": "{}",
    }),
    IS_PNPM_APP,
  ),
  true,
  "a stray package-lock.json must not flip a pnpm app back to npm",
);

// The install command branches on the same test, in the shell.
const command = installCommand({ verbose: true });
assert.match(command, /^if \{ \[ -f pnpm-lock\.yaml \]/);
assert.match(
  command,
  /install --no-frozen-lockfile --config\.confirmModulesPurge=false --reporter=append-only/,
);
assert.match(
  command,
  /else npm install --no-audit --no-fund --loglevel=http --foreground-scripts; fi$/,
);
assert.doesNotMatch(installCommand(), /append-only|loglevel/);

// Freshness: the stamp must be newer than package.json AND the lockfile.
{
  const dir = appDir({
    "package.json": pkg(),
    "pnpm-lock.yaml": "",
    "node_modules/.mako-installed": "",
  });
  touch(dir, "package.json", 60);
  touch(dir, "pnpm-lock.yaml", 60);
  assert.equal(succeeds(dir, INSTALL_IS_FRESH), true);
  touch(dir, "pnpm-lock.yaml", 0);
  touch(dir, "node_modules/.mako-installed", 30);
  assert.equal(
    succeeds(dir, INSTALL_IS_FRESH),
    false,
    "a lockfile-only change reinstalls",
  );
}
{
  const dir = appDir({ "package.json": pkg(), "package-lock.json": "{}" });
  assert.equal(
    succeeds(dir, INSTALL_IS_FRESH),
    false,
    "no stamp, no fresh install",
  );
}

// Floating @makoai/* inside the declared range: only apps that depend on one.
assert.equal(
  succeeds(
    appDir({
      "package.json": pkg({ dependencies: { "@makoai/app-sdk": "^2.7.0" } }),
    }),
    DEPENDS_ON_MAKO_PACKAGES,
  ),
  true,
);
assert.equal(
  succeeds(
    appDir({
      "package.json": pkg({
        dependencies: { "@mako/app-sdk": "file:./vendor/app-sdk" },
      }),
    }),
    DEPENDS_ON_MAKO_PACKAGES,
  ),
  false,
  "a vendored @mako/ copy is not ours to float",
);
{
  // No @makoai dependency: the command is a no-op that never reaches a
  // package manager (so it cannot fail or touch the network).
  const dir = appDir({
    "package.json": pkg({ dependencies: { react: "^18" } }),
  });
  const run = spawnSync("bash", ["-c", updateMakoPackagesCommand()], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
}
assert.match(updateMakoPackagesCommand(), /update '@makoai\/\*'/);
assert.doesNotMatch(
  updateMakoPackagesCommand(),
  /--latest/,
  "stay inside the declared range",
);

console.log("package-manager: ok");
