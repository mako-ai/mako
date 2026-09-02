/**
 * The dispatcher: every command in HELP must actually be routed. `mako
 * connection probe` shipped with its module wired to nothing — the tests
 * exercised `connection()` directly and never noticed — so this pins the
 * command table from the outside, through `main()`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./main.js";

async function run(argv) {
  const lines = [];
  const code = await main(argv, { log: line => lines.push(line) });
  return { code, output: lines.join("\n") };
}

test("help lists connector test and connection probe, and both are routed", async () => {
  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.output, /mako connector test/);
  assert.match(help.output, /mako connection probe/);
  assert.doesNotMatch(help.output, /mako connector probe/);

  // A bare subcommand family prints its own help and exits 0.
  const connection = await run(["connection"]);
  assert.equal(connection.code, 0);
  assert.match(connection.output, /mako connection probe <id\|name>/);

  // The old spelling is refused by the family that no longer owns it.
  const stale = await run(["connector", "probe", "x"]);
  assert.equal(stale.code, 2);
  assert.match(stale.output, /mako connection probe/);
});

test("an unknown command is refused with the help", async () => {
  const { code, output } = await run(["conection"]);
  assert.equal(code, 2);
  assert.match(output, /unknown command "conection"/);
});
