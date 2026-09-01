/**
 * `check_flow_files` — what a `flows/<slug>.yml` change would do, before it is
 * pushed.
 *
 * RFC `rfcs/agent-authored-flows.md` items 1 and 2 shipped the two halves of
 * this answer and left both out of reach of the agent the RFC is about:
 * `validateFlowFiles` had one caller, a CLI in the *mako* monorepo, while the
 * person in the scenario has the *workspace* repo checked out; and
 * `dryRunFlowReconcile` had no non-test caller at all. This is the MCP-facing
 * surface the RFC's design asks for ("an MCP tool — for the agent").
 *
 * Three layers behind one call: it parses, it resolves the ids against this
 * workspace, and it hydrates the row the file would produce and asks mongoose
 * whether that row is valid — a file can clear the first two and still be
 * refused by `doc.save()` (a layout with no `partition_field`, a `write_mode`
 * outside the enum), which the push path swallows as "keeping current row".
 *
 * ONE tool, not two, and deliberately so. An agent that can call the validator
 * alone will call the validator alone: it answers "will this load", which is
 * the reassuring half. The half worth having is the destructive one — a
 * missing file is a stream teardown, an entity dropped from a selection
 * disposes that entity's checkpoint, and neither is recoverable by putting
 * the file back (the flow returns and re-backfills from scratch).
 *
 * THE INPUT IS AN OVERLAY, NOT A DIRECTORY. `wouldTeardown` is computed from
 * ABSENCE, so a tool that took "the files you are proposing" and treated them
 * as the whole of `flows/` would report a catastrophic teardown every time an
 * agent passed the two files it edited. So the rest of the directory is read
 * from the workspace repo at main and the caller's files are merged on top of
 * it, and a teardown is only ever ATTRIBUTED to the caller when they said so:
 *   - `deletedPaths` names the file, or
 *   - the file they passed cannot be parsed, which the push path treats as
 *     absence (see `preExisting`/`notes` — that behaviour is a trap and this
 *     tool's job is to show it, not to hide it).
 * Everything else lands in `preExisting`, which says "true of the repo before
 * your change". Two independent mechanisms, because the failure they prevent
 * is an agent being told it is about to delete a workspace's data pipelines.
 *
 * Read-only, end to end: it reads Mongo and the local repo cache, and calls
 * `dryRunFlowReconcile`, which shares its decision function with the real
 * reconciler but performs none of the writes. It does not freshen the local
 * repo either — a read is not allowed to reset a shared clone.
 */
import { tool } from "ai";
import { z } from "zod";

import { loggers } from "../../logging";
import {
  parseFlowFile,
  slugFromFlowFilePath,
} from "../../services/flow-config-files";
import {
  hydrateFlowRow,
  readFlowFilesAtMain,
} from "../../services/flow-sync.service";
import {
  validateFlowFiles,
  type FlowFileProblem,
} from "../../services/flow-validate.service";
import {
  dryRunFlowReconcile,
  type PlannedFlow,
  type ReconcilePlan,
} from "../../sync-cdc/flow-reconcile";

const logger = loggers.api("flow-file-tools");

export interface ProposedFlowFile {
  path: string;
  contents: string;
}

export interface CheckFlowFilesResult {
  /** True when every proposed file parses and every id it names resolves. */
  ok: boolean;
  summary: string;
  problems: FlowFileProblem[];
  /** What the workspace repo's main says today — the baseline merged under. */
  baseline: {
    commit: string | null;
    flowFiles: number;
    note: string;
  };
  /** How the proposed files land on that baseline. */
  overlay: {
    added: string[];
    replaced: string[];
    unchanged: string[];
    deleted: string[];
  };
  /** Caused by this change. */
  wouldCreate: string[];
  wouldReconfigure: Array<{ slug: string; entities: string[] }>;
  wouldTeardown: string[];
  guard: ReconcilePlan["guard"];
  /** True of the repo already — a push would do this with or without you. */
  preExisting: {
    wouldCreate: string[];
    wouldReconfigure: Array<{ slug: string; entities: string[] }>;
    wouldTeardown: string[];
  };
  notes: string[];
}

function sortedDiff(
  proposed: string[],
  baseline: string[],
): { caused: string[]; preExisting: string[] } {
  const before = new Set(baseline);
  return {
    caused: proposed.filter(slug => !before.has(slug)).sort(),
    preExisting: proposed.filter(slug => before.has(slug)).sort(),
  };
}

/**
 * The whole answer, as a value. Separated from the `tool()` wrapper so it can
 * be exercised against a real repo + database without a model in the loop.
 */
export async function checkFlowFiles(input: {
  workspaceId: string;
  files: ProposedFlowFile[];
  deletedPaths?: string[];
}): Promise<CheckFlowFilesResult> {
  const { workspaceId } = input;
  const files = input.files ?? [];
  const deletedPaths = input.deletedPaths ?? [];
  const notes: string[] = [];
  const problems: FlowFileProblem[] = [];

  // ---- the baseline: everything else in flows/, so nothing looks deleted --
  const baseline = await readFlowFilesAtMain(workspaceId, { freshen: false });
  const baselineByPath = new Map(
    baseline.files.map(f => [f.path, f.contents] as const),
  );

  // ---- structural + referential validation of the caller's files ---------
  const validation = await validateFlowFiles({ workspaceId, files });
  problems.push(...validation.problems);

  // ---- and the layer neither of those covers: the model's own schema -----
  // A file can parse, resolve every id it names, and still be refused by
  // `doc.save()` — a layout with no `partition_field`, a `write_mode` outside
  // the enum. The reactor logs that and keeps the current row, so the agent
  // sees a green push and no flow.
  const schemaProblems: FlowFileProblem[] = [];
  for (const file of files) {
    const slug = slugFromFlowFilePath(file.path);
    if (!slug) continue;
    const parsed = parseFlowFile(file.contents);
    if (!parsed) continue; // Already reported by the structural layer.
    const hydrated = hydrateFlowRow(parsed, {
      workspaceId,
      slug,
      // Not in the file: `createdBy` is the acting user and the reactor
      // supplies it. A placeholder keeps this layer reporting the file's
      // problems rather than that one.
      createdBy: "check",
    });
    if (hydrated.refusal) {
      schemaProblems.push({
        path: file.path,
        slug,
        reason: `the push reactor would refuse this file: ${hydrated.refusal}`,
      });
      continue;
    }
    for (const err of hydrated.schemaErrors) {
      schemaProblems.push({
        path: file.path,
        slug,
        reason: `\`${err.path}\`: ${err.message} — the flow row would fail to save, so the push would leave the flow unchanged`,
      });
    }
  }
  problems.push(...schemaProblems);

  const deletedSlugs = new Set<string>();
  for (const path of deletedPaths) {
    const slug = slugFromFlowFilePath(path);
    if (!slug) {
      problems.push({
        path,
        reason: `\`${path}\` is not a flow file (\`flows/<slug>.yml\`), so deleting it removes no flow`,
      });
      continue;
    }
    if (!baselineByPath.has(path)) {
      notes.push(
        `\`${path}\` is not in the repo at main, so there is nothing to delete there.`,
      );
    }
    deletedSlugs.add(slug);
  }

  // ---- overlay the proposal onto the baseline ----------------------------
  const overlay = {
    added: [] as string[],
    replaced: [] as string[],
    unchanged: [] as string[],
    deleted: [] as string[],
  };
  /** Slug → the file that will be there after this change, and its origin. */
  const proposedByPath = new Map<
    string,
    { contents: string; pendingApply: boolean }
  >();
  for (const [path, contents] of baselineByPath) {
    proposedByPath.set(path, { contents, pendingApply: false });
  }
  for (const path of deletedPaths) {
    if (proposedByPath.delete(path)) overlay.deleted.push(path);
  }

  /** Caller files whose contents cannot be loaded — absence, to the reactor. */
  const unparseableSlugs = new Set<string>();
  for (const file of files) {
    const slug = slugFromFlowFilePath(file.path);
    if (!slug) continue; // Already reported as a problem by the validator.
    const before = baselineByPath.get(file.path);
    if (before === undefined) overlay.added.push(file.path);
    else if (before === file.contents) overlay.unchanged.push(file.path);
    else overlay.replaced.push(file.path);
    // A file identical to the one already committed applies nothing: the sync
    // path short-circuits on a matching blob sha, so the row keeps its own
    // selection. Anything else would be applied before the reconcile runs.
    proposedByPath.set(file.path, {
      contents: file.contents,
      pendingApply: before !== file.contents,
    });
    if (!parseFlowFile(file.contents)) unparseableSlugs.add(slug);
  }

  const plannedFrom = (
    entries: Iterable<[string, { contents: string; pendingApply: boolean }]>,
  ): PlannedFlow[] => {
    const planned: PlannedFlow[] = [];
    for (const [path, { contents, pendingApply }] of entries) {
      const slug = slugFromFlowFilePath(path);
      if (!slug) continue;
      const file = parseFlowFile(contents);
      // A file that does not parse is left OUT, exactly as `syncFlowsFromRepo`
      // leaves it out of its desired set. That is faithful rather than kind:
      // the reconciler reads the resulting absence as a removal.
      if (!file) continue;
      planned.push({ slug, file, pendingApply });
    }
    return planned;
  };

  const baselineInvalid = baseline.files
    .filter(f => !parseFlowFile(f.contents))
    .map(f => f.path);
  if (baselineInvalid.length > 0) {
    notes.push(
      `Already in the repo and not parseable: ${baselineInvalid.join(", ")}. The push path skips such a file, which the reconciler reads as absence — that is why they appear under preExisting.`,
    );
  }

  // Two plans: the repo as it stands, and the repo with this change on top.
  // The difference is what the change causes; the rest was already true.
  // `treeSha` is deliberately omitted from both — see the guard note below.
  const baselineEntries: Array<
    [string, { contents: string; pendingApply: boolean }]
  > = [...baselineByPath].map(([path, contents]) => [
    path,
    { contents, pendingApply: false },
  ]);
  const baselinePlan = await dryRunFlowReconcile({
    workspaceId,
    desired: plannedFrom(baselineEntries),
  });
  const proposedPlan = await dryRunFlowReconcile({
    workspaceId,
    desired: plannedFrom(proposedByPath.entries()),
  });

  const created = sortedDiff(
    proposedPlan.wouldCreate,
    baselinePlan.wouldCreate,
  );
  const reconfiguredBefore = new Map(
    baselinePlan.wouldReconfigure.map(
      r => [r.slug, r.entities.join("|")] as const,
    ),
  );
  const reconfigureCaused: Array<{ slug: string; entities: string[] }> = [];
  const reconfigurePreExisting: Array<{ slug: string; entities: string[] }> =
    [];
  for (const entry of proposedPlan.wouldReconfigure) {
    if (reconfiguredBefore.get(entry.slug) === entry.entities.join("|")) {
      reconfigurePreExisting.push(entry);
    } else {
      reconfigureCaused.push(entry);
    }
  }

  // Teardown attribution is by explicit intent ONLY — the caller said "I
  // deleted this", or handed over a file that cannot be loaded. A flow whose
  // file is simply not in the repo is torn down by any push, with or without
  // this change, and saying otherwise is the exact false alarm this tool must
  // never raise.
  const wouldTeardown = proposedPlan.wouldTeardown.filter(
    slug => deletedSlugs.has(slug) || unparseableSlugs.has(slug),
  );
  const teardownPreExisting = proposedPlan.wouldTeardown.filter(
    slug => !deletedSlugs.has(slug) && !unparseableSlugs.has(slug),
  );

  for (const slug of wouldTeardown) {
    if (unparseableSlugs.has(slug)) {
      notes.push(
        `\`${slug}\`: the file you passed does not parse. Pushing it is worse than a no-op — the sync path skips an unparseable file, and the reconciler reads that absence as a removal, so the flow and its checkpoints go. Fix the file before committing.`,
      );
    }
  }
  if (teardownPreExisting.length > 0) {
    notes.push(
      `These flows have rows but no file in \`flows/\` at main: ${teardownPreExisting.join(", ")}. A push tears them down whether or not you change anything — that is not caused by these files.`,
    );
  }
  if (
    proposedPlan.wouldTeardown.length > 0 ||
    proposedPlan.wouldReconfigure.length > 0
  ) {
    notes.push(
      "A teardown deletes the flow and disposes its CDC checkpoints; a dropped entity disposes that entity's checkpoint. Re-adding the file brings the flow back and re-backfills from scratch.",
    );
  }
  if (baseline.commit === null) {
    notes.push(
      "The workspace repo has no main branch on this instance yet, so the baseline is empty and nothing could be merged under your files.",
    );
  }

  // `validation.ok` is already folded in: its problems are all in `problems`,
  // and the schema layer adds the ones it cannot see.
  const blocking = problems.filter(p => !p.reason.startsWith("note:"));
  const ok = blocking.length === 0;
  const summary = [
    ok ? "files load" : "NOT loadable",
    `${blocking.length} problem(s)`,
    `create ${created.caused.length}`,
    `reconfigure ${reconfigureCaused.length}`,
    `teardown ${wouldTeardown.length}`,
  ].join("; ");

  return {
    ok,
    summary,
    problems,
    baseline: {
      commit: baseline.commit,
      flowFiles: baseline.files.length,
      note: "Read from the workspace repo's main branch and merged under your files, so a flow you did not mention is never read as deleted.",
    },
    overlay,
    wouldCreate: created.caused,
    wouldReconfigure: reconfigureCaused,
    wouldTeardown,
    guard: proposedPlan.guard,
    preExisting: {
      wouldCreate: created.preExisting,
      wouldReconfigure: reconfigurePreExisting,
      wouldTeardown: teardownPreExisting,
    },
    notes,
  };
}

export function createFlowFileTools(workspaceId: string) {
  return {
    check_flow_files: tool({
      description: [
        "Check proposed `flows/<slug>.yml` files BEFORE committing them: whether each parses, whether the connector/connection ids it names exist in this workspace, whether the flow row it describes would actually save, and what the resulting push would do to running syncs (create, reconfigure, tear down).",
        "Pass ONLY the files you added or changed. The rest of `flows/` is read from the workspace repo's main branch and merged underneath yours, so a flow you do not mention is never read as deleted.",
        "To check a DELETION, name its path in `deletedPaths`. That, or a file that fails to parse, is the only way a teardown is attributed to you — and a teardown deletes the flow and disposes its CDC checkpoints, which re-adding the file does not recover.",
        "Read-only: nothing is created, changed, deleted, or committed, and this never pushes.",
      ].join("\n"),
      inputSchema: z.object({
        files: z
          .array(
            z.object({
              path: z
                .string()
                .describe(
                  "Repo-relative path, e.g. `flows/stripe-to-bigquery.yml`. The slug in the filename is the flow's permanent identity.",
                ),
              contents: z
                .string()
                .describe("The full YAML you intend to commit."),
            }),
          )
          .describe(
            "The flow files you added or changed — NOT the whole directory.",
          ),
        deletedPaths: z
          .array(z.string())
          .optional()
          .describe(
            "Flow files you intend to DELETE, repo-relative. Omit unless you really mean to remove a flow.",
          ),
      }),
      execute: async ({
        files,
        deletedPaths,
      }: {
        files: ProposedFlowFile[];
        deletedPaths?: string[];
      }) => {
        try {
          return await checkFlowFiles({ workspaceId, files, deletedPaths });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          logger.error("check_flow_files failed", {
            workspaceId,
            error: message,
          });
          return { error: `Failed to check flow files: ${message}` };
        }
      },
    }),
  };
}
