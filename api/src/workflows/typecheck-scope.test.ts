/**
 * The typecheck before a sandbox run (deploy/workflows/runtime/build.mjs
 * `typecheckCheckout`) covers the workflow being run and the shared code,
 * not the other workflows' folders: a sandbox checkout is shared by every
 * chat of a person, and another chat's half-done edit must not refuse this
 * run. Without a workflow name (the scope of a deploy) everything is checked.
 *
 * Needs the runtime's packages: npm install --prefix deploy/workflows/runtime
 *
 * Run with: pnpm --filter api exec tsx src/workflows/typecheck-scope.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

type Build = {
  typecheckCheckout: (checkout: string, workflow?: string) => string | null;
};

const BUILD = path.resolve(
  __dirname,
  "../../../deploy/workflows/runtime/build.mjs",
);

const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "mako-scope-test-"));
after(() => fs.rmSync(checkout, { recursive: true, force: true }));

const write = (file: string, source: string) => {
  const target = path.join(checkout, "workflows", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

// Shared code, a clean workflow that uses it, a broken one that does not.
write(
  "lib/format.ts",
  `export const shout = (s: string): string => s + "!";\n`,
);
write(
  "clean/workflow.ts",
  `import { shout } from "../lib/format.ts";\nexport const out: string = shout("hi");\n`,
);
write("broken/workflow.ts", `export const n: number = "not a number";\n`);
// A workflow that imports from the broken one: its errors are its own.
write(
  "borrower/workflow.ts",
  `import { n } from "../broken/workflow.ts";\nexport const m: number = n;\n`,
);

void test("a sandbox run checks its workflow and the shared code only", async () => {
  const { typecheckCheckout } = (await import(
    pathToFileURL(BUILD).href
  )) as Build;

  // The deploy's scope: every workflow, so the broken one fails it.
  const all = typecheckCheckout(checkout);
  assert.match(all ?? "", /workflows\/broken\/workflow\.ts.*TS2322/);

  // One workflow's run: the sibling's error is not this run's.
  assert.equal(typecheckCheckout(checkout, "clean"), null);

  // A run of the broken workflow still fails on its own errors.
  assert.match(
    typecheckCheckout(checkout, "broken") ?? "",
    /workflows\/broken\/workflow\.ts.*TS2322/,
  );

  // Code a workflow imports from another folder is still checked.
  assert.match(
    typecheckCheckout(checkout, "borrower") ?? "",
    /workflows\/broken\/workflow\.ts.*TS2322/,
  );

  // Shared code is in every run's scope.
  write("lib/format.ts", `export const shout = (s: string): number => s;\n`);
  assert.match(
    typecheckCheckout(checkout, "borrower") ?? "",
    /workflows\/lib\/format\.ts.*TS2322/,
  );
});
