/**
 * SandboxExecOptions.hideCommand: the command runs, its text never shows in
 * argv, and no child process inherits it.
 *
 * Run: node --import tsx src/apps/sandbox/hidden-command.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  HIDDEN_COMMAND_ENV,
  HIDDEN_COMMAND_SHIM,
  commandToRun,
} from "./hidden-command";

void test("a plain command runs as given", () => {
  assert.deepEqual(commandToRun("echo hi", { env: { A: "1" } }), {
    command: "echo hi",
    env: { A: "1" },
  });
});

void test("a hidden command travels in the environment, under a fixed shim", () => {
  const secret = "/var/lib/mako-connectors/sessions/0123456789abcdef";
  const run = commandToRun(`printf '%s' ${secret}`, {
    env: { A: "1" },
    hideCommand: true,
  });
  assert.equal(run.command, HIDDEN_COMMAND_SHIM);
  assert.ok(!run.command.includes(secret));
  assert.equal(run.env.A, "1");
  assert.equal(run.env[HIDDEN_COMMAND_ENV], `printf '%s' ${secret}`);
});

void test("the shim runs the command, and its children never inherit it", () => {
  const run = commandToRun(
    `x='a b'; printf '%s|' "$x"; printf '%s|' "\${${HIDDEN_COMMAND_ENV}:-unset}"; bash -c 'printf "%s" "\${${HIDDEN_COMMAND_ENV}:-unset}"'`,
    { hideCommand: true },
  );
  const out = execFileSync("bash", ["-c", run.command], {
    env: { PATH: process.env.PATH, ...run.env },
    encoding: "utf8",
  });
  assert.equal(out, "a b|unset|unset");
});
