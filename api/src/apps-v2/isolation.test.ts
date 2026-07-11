import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AppV2ScaffoldFiles } from "@mako/schemas";

async function run(): Promise<void> {
  const appsV2Root = path.resolve(__dirname);
  const entries = await readdir(appsV2Root, {
    recursive: true,
    withFileTypes: true,
  });
  const sourceFiles = entries.filter(
    entry => entry.isFile() && entry.name.endsWith(".ts"),
  );
  const forbiddenImports = [
    ["Mako", "App"].join(""),
    ["app", ".schema"].join(""),
    ["app", "-scaffold"].join(""),
    ['from "../routes/', 'apps"'].join(""),
    ["from '../routes/", "apps'"].join(""),
  ];
  for (const entry of sourceFiles) {
    if (entry.name === "isolation.test.ts") continue;
    const source = await readFile(
      path.join(entry.parentPath, entry.name),
      "utf8",
    );
    for (const forbidden of forbiddenImports) {
      assert.equal(
        source.includes(forbidden),
        false,
        `${entry.name} imports or references Apps v1 (${forbidden})`,
      );
    }
  }

  const scaffoldRoot = path.resolve(
    __dirname,
    "../../../packages/schemas/app-v2-scaffold",
  );
  const generatedByPath = new Map(
    AppV2ScaffoldFiles.map(file => [file.path, file.contents]),
  );
  const scaffoldEntries = await readdir(scaffoldRoot, {
    recursive: true,
    withFileTypes: true,
  });
  const checkedInPaths = scaffoldEntries
    .filter(
      entry =>
        entry.isFile() &&
        !entry.parentPath.includes(`${path.sep}node_modules`) &&
        !entry.parentPath.includes(`${path.sep}dist`) &&
        !entry.name.endsWith(".tsbuildinfo"),
    )
    .map(entry =>
      path
        .relative(scaffoldRoot, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
  assert.deepEqual(
    [...generatedByPath.keys()].sort(),
    checkedInPaths,
    "generated scaffold path set must exactly match the checked-in scaffold",
  );
  for (const checkedInPath of checkedInPaths) {
    const checkedIn = await readFile(
      path.join(scaffoldRoot, checkedInPath),
      "utf8",
    );
    assert.equal(generatedByPath.get(checkedInPath), checkedIn);
  }
  const packageJson = JSON.parse(
    await readFile(path.join(scaffoldRoot, "package.json"), "utf8"),
  ) as { packageManager?: unknown; dependencies?: Record<string, unknown> };
  assert.equal(packageJson.packageManager, "pnpm@10.33.3");
  assert.equal(packageJson.dependencies?.["@mako/app-sdk"], undefined);
}

void run().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
