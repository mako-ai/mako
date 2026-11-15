/**
 * Staging an app's binding data into its dev session, each file replaced
 * whole (never written in place).
 */
import {
  getSandboxProvider,
  type SandboxExecContext,
} from "../sandbox/provider";
import { type WorktreeHandle, handleProject } from "../worktree.service";
import { loggers } from "../../logging";
import { sh } from "../box";
import { readBindings, bindingArtifactKey } from "../bindings.service";
import { snapshotArtifactKey } from "../../services/binding-snapshot";
import { getArtifactStore } from "../../services/artifact-store.service";

import { dataDir } from "./paths";

const logger = loggers.api("apps-dev-server");

/**
 * Write a staged file under a temporary name, then rename it into place.
 * The dev server reads these files while a reattach restages them in the
 * background; a write in place (truncate, then fill) let a page reload read a
 * half-written parquet and fail with "No magic bytes found at end of file".
 * `then` runs in the same exec as the rename, sparing a round-trip.
 */
export async function stageFileAtomically(
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
  target: string,
  bytes: Uint8Array,
  then?: string,
  /** Runs (and must succeed) right before the move. */
  before?: string,
): Promise<void> {
  const temp = `${target}.staging`;
  await provider.writeFile(ctx, temp, bytes);
  const moved = await provider.exec(
    ctx,
    `${before ? `${before} && ` : ""}mv -f ${sh(temp)} ${sh(target)}${then ? ` && ${then}` : ""}`,
    { timeoutMs: 15_000 },
  );
  if (moved.exitCode !== 0) {
    throw new Error(`Could not stage ${target}: ${moved.stderr.trim()}`);
  }
}

/**
 * Copy each materialized binding's parquet into the sandbox so the dev server
 * can answer `__data/<name>.parquet` locally.
 *
 * Pushing the bytes in (rather than having the sandbox call back to Mako)
 * keeps this working identically in local development and in deployed
 * environments: a sandbox can always reach the public internet, but it can
 * never reach a developer's localhost API.
 *
 * Bindings that have never been materialized are skipped, and the dev server
 * answers 404 with a readable reason rather than serving HTML as parquet.
 */
export async function stageBindingData(
  handle: WorktreeHandle,
  provider: ReturnType<typeof getSandboxProvider>,
  ctx: SandboxExecContext,
): Promise<string[]> {
  const project = handleProject(handle);
  const projectId = project._id.toString();
  let bindings: Awaited<ReturnType<typeof readBindings>>;
  try {
    bindings = await readBindings(project, handle.doc.userId);
  } catch {
    return [];
  }
  if (bindings.length === 0) return [];

  const stageDir = dataDir(handle);
  await provider.exec(ctx, `mkdir -p ${stageDir}`, { timeoutMs: 30_000 });

  const store = getArtifactStore();
  const staged: string[] = [];
  // A marker (no parquet) tells the dev server's data middleware to fetch this
  // binding FRESH from Mako on each request. Listed in index.json so the SDK
  // still registers the table.
  const stageLive = async (name: string) => {
    await provider.writeFile(
      ctx,
      `${stageDir}/${name}.live`,
      new TextEncoder().encode("1"),
    );
    staged.push(name);
  };
  for (const binding of bindings) {
    if (binding.materialization === "live") {
      await stageLive(binding.name);
      continue;
    }
    const key = bindingArtifactKey(binding);
    const stream = await store.openReadStream(key);
    if (!stream) {
      // A scheduled binding with no materialized artifact yet (never built, or
      // its data lives only in the prod store). Rather than leave the app with
      // a missing DuckDB table, fall back to LIVE — query it fresh on demand —
      // so dev mode always shows data. A real build later replaces the marker
      // with a static parquet (the stale-marker rm below handles that). Dev
      // only: the box token authorizes the live query; a published app never
      // reaches this path.
      await stageLive(binding.name);
      continue;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    // A stale marker from a previous life mustn't shadow a now-static
    // binding. The previous build's snapshot goes BEFORE the parquet moves,
    // and this build's lands after it: never an old preview beside new data.
    await stageFileAtomically(
      provider,
      ctx,
      `${stageDir}/${binding.name}.parquet`,
      new Uint8Array(Buffer.concat(chunks)),
      `rm -f ${stageDir}/${binding.name}.live`,
      `rm -f ${stageDir}/${binding.name}.snapshot.json`,
    );
    const snapshotStream = await store.openReadStream(snapshotArtifactKey(key));
    if (snapshotStream) {
      const snapChunks: Buffer[] = [];
      for await (const chunk of snapshotStream) {
        snapChunks.push(Buffer.from(chunk as Buffer));
      }
      await stageFileAtomically(
        provider,
        ctx,
        `${stageDir}/${binding.name}.snapshot.json`,
        new Uint8Array(Buffer.concat(snapChunks)),
      );
    }
    staged.push(binding.name);
  }

  // The staged names as a file beside the data, so the app-side SDK's
  // useDuckDB can register every binding without a Mako API in reach —
  // the same relative fetch that gets it the parquet gets it the list.
  await stageFileAtomically(
    provider,
    ctx,
    `${stageDir}/index.json`,
    new TextEncoder().encode(JSON.stringify(staged)),
  );
  if (staged.length > 0) {
    logger.info("Apps staged binding data into the sandbox", {
      projectId,
      bindings: staged,
    });
  }
  return staged;
}
