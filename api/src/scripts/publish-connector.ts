/* eslint-disable no-console */
/**
 * Publish Mako connector folders to the connector registry.
 *
 * Run by .github/workflows/connector-release.yml; by hand from api/:
 *
 *   pnpm exec tsx src/scripts/publish-connector.ts --tag connector-stripe-v1.0.0
 *   pnpm exec tsx src/scripts/publish-connector.ts --slug stripe --version 1.0.0 --dry-run
 *   pnpm exec tsx src/scripts/publish-connector.ts --all --dry-run
 *
 * `--all` takes every top-level `connectors/<slug>/` at the version its
 * package.json declares. `--dry-run` builds, runs `spec` and `discover` on the
 * bundle and prints the catalog entry, and writes nothing.
 *
 * Storage is the artifact store the API uses (DASHBOARD_ARTIFACT_STORE=gcs
 * with GCS_DASHBOARD_BUCKET in the workflow), under CONNECTOR_REGISTRY_PREFIX
 * (default `connector-registry`). The build and the spec run happen in the
 * local sandbox provider unless APPS_SANDBOX_PROVIDER says otherwise: the
 * runner is a throwaway CI machine holding no tenant data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Target {
  slug: string;
  version: string;
}

const TAG = /^connector-([a-z][a-z0-9-]*)-v(\d+\.\d+\.\d+)$/;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Run this inside the Mako repository.");
    dir = parent;
  }
}

function targets(
  flags: Record<string, string | boolean>,
  root: string,
): Target[] {
  if (typeof flags.tag === "string") {
    const match = TAG.exec(flags.tag.replace(/^refs\/tags\//, ""));
    if (!match) {
      throw new Error(
        `"${flags.tag}" is not a connector release tag; expected connector-<slug>-v<MAJOR.MINOR.PATCH>, e.g. connector-stripe-v1.0.0.`,
      );
    }
    return [{ slug: match[1], version: match[2] }];
  }
  if (typeof flags.slug === "string" && typeof flags.version === "string") {
    return [{ slug: flags.slug, version: flags.version }];
  }
  if (flags.all) {
    const dir = path.join(root, "connectors");
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry =>
        fs.existsSync(path.join(dir, entry.name, "connector.yaml")),
      )
      .map(entry => {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(dir, entry.name, "package.json"), "utf8"),
        ) as { version?: string };
        if (!manifest.version) {
          throw new Error(
            `connectors/${entry.name}/package.json has no version.`,
          );
        }
        return { slug: entry.name, version: manifest.version };
      });
  }
  throw new Error(
    "Pass --tag <tag>, --slug <slug> --version <x.y.z>, or --all.",
  );
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;
  const root = repoRoot();

  // The release builds on the runner itself unless told otherwise.
  process.env.APPS_SANDBOX_PROVIDER ??= "local";
  process.env.APPS_SESSIONS_ROOT ??= fs.mkdtempSync(
    path.join(os.tmpdir(), "mako-connector-release-"),
  );

  const { publishConnector, cleanupPublishBoxes } =
    await import("../connectors/workspace/registry/publish");
  const commit =
    typeof flags.commit === "string" ? flags.commit : process.env.GITHUB_SHA;

  const results = [];
  let failed = 0;
  try {
    for (const target of targets(flags, root)) {
      const folder = path.join(root, "connectors", target.slug);
      if (!fs.existsSync(path.join(folder, "connector.yaml"))) {
        console.error(`connectors/${target.slug}/ has no connector.yaml.`);
        failed++;
        continue;
      }
      try {
        const result = await publishConnector({
          folder,
          slug: target.slug,
          version: target.version,
          dryRun,
          commit,
        });
        results.push(result);
        const verb = dryRun
          ? "would publish"
          : result.alreadyPublished
            ? "already published"
            : "published";
        console.log(
          `mako/${result.slug}@${result.version}: ${verb} (hash ${result.hash.slice(0, 12)}, ` +
            `${result.entry.bytes} bytes, ${result.entry.entities.length} entities, auth ${result.entry.authType})`,
        );
      } catch (error) {
        failed++;
        console.error(
          `mako/${target.slug}@${target.version}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await cleanupPublishBoxes();
  }

  console.log(JSON.stringify(results, null, 2));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = results.map(
      r =>
        `| mako/${r.slug} | ${r.version} | \`${r.hash.slice(0, 12)}\` | ${r.entry.bytes} | ${r.entry.entities.length} | ${r.entry.authType} | ${dryRun ? "dry run" : r.alreadyPublished ? "already published" : "published"} |`,
    );
    fs.appendFileSync(
      summary,
      [
        "| Connector | Version | Hash | Bytes | Entities | Auth | Result |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...rows,
        "",
      ].join("\n"),
    );
  }
  return failed === 0 ? 0 : 1;
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
