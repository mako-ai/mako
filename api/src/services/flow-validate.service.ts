/**
 * Validate `flows/<slug>.yml` before it is pushed.
 *
 * RFC `rfcs/agent-authored-flows.md` item 1. The sync path treats a bad file as
 * "keep the current row and move on" — correct there, and useless to whoever
 * wrote the file: an agent that pushes and receives no error cannot correct
 * itself, and a silent no-op is indistinguishable from success.
 *
 * Two layers, in increasing order of what they catch:
 *
 *  - STRUCTURAL — does it parse, are the required fields there. Delegated to
 *    `parseFlowFileResult` so the validator cannot disagree with the parser.
 *    A validator that certifies files the parser rejects is worse than none.
 *  - REFERENTIAL — do the ids resolve, is the slug free. This is the layer that
 *    matters for an agent: it cannot invent an ObjectId, and a well-formed file
 *    naming a connection that does not exist is the likeliest mistake and is
 *    currently invisible until someone reads a warn log.
 *
 * Deliberately NOT here: whether the flow is a good idea, and what it would do
 * to running streams. The second is the dry-run's job (RFC item 2) — this
 * answers "is this file loadable", not "what happens if I push it".
 */
import { Types } from "mongoose";

import {
  DatabaseConnection,
  Connector,
  Flow,
} from "../database/workspace-schema";
import { parseFlowFileResult, slugFromFlowFilePath } from "./flow-config-files";

export interface FlowFileProblem {
  /** Repo-relative path, when the caller has one. */
  path?: string;
  slug?: string;
  /** What is wrong, phrased so the fix is obvious. */
  reason: string;
}

export interface FlowValidation {
  ok: boolean;
  problems: FlowFileProblem[];
}

function isObjectId(value: string | undefined): boolean {
  return typeof value === "string" && Types.ObjectId.isValid(value);
}

/**
 * Validate one file's contents.
 *
 * `slug` comes from the filename because the filename IS the identity — a file
 * whose name does not yield a slug can never be loaded, however good its
 * contents.
 */
export async function validateFlowFile(input: {
  workspaceId: string;
  /** Repo-relative, e.g. `flows/stripe-to-bigquery.yml`. */
  path: string;
  contents: string;
}): Promise<FlowValidation> {
  const { workspaceId, path, contents } = input;
  const problems: FlowFileProblem[] = [];
  const slug = slugFromFlowFilePath(path);

  if (!slug) {
    return {
      ok: false,
      problems: [
        {
          path,
          reason:
            "not a flow file: it must be `flows/<slug>.yml`, and the slug in the filename is the flow's permanent identity",
        },
      ],
    };
  }

  const parsed = parseFlowFileResult(contents);
  if (!parsed.ok) {
    // Structural failure: referential checks would be noise on top of a file
    // that cannot be loaded at all.
    return { ok: false, problems: [{ path, slug, reason: parsed.reason }] };
  }

  const file = parsed.file;
  const add = (reason: string): void => {
    problems.push({ path, slug, reason });
  };

  // ---- referential: the ids must exist, in THIS workspace ----------------
  if (file.source.type === "connector") {
    const id = file.source.connectorId;
    if (!id) {
      add(
        "`source.connection_id:` is required for a connector source (the id of a source connection from list_connections)",
      );
    } else if (!isObjectId(id)) {
      add(`\`source.connection_id: ${id}\` is not a valid id`);
    } else if (!(await Connector.exists({ _id: id, workspaceId }))) {
      add(
        `\`source.connection_id: ${id}\` does not name a source connection in this workspace — configure the connection first (Sources → Add), then reference the id list_connections returns`,
      );
    }
  } else {
    const id = file.source.connectionId;
    if (id && !isObjectId(id)) {
      add(`\`source.connection_id: ${id}\` is not a valid id`);
    } else if (
      id &&
      !(await DatabaseConnection.exists({ _id: id, workspaceId }))
    ) {
      add(
        `\`source.connection_id: ${id}\` does not name a database connection in this workspace`,
      );
    }
  }

  const destId = file.destination.connectionId;
  if (!destId) {
    add(
      "`destination.connection_id:` is required — a flow needs somewhere to write",
    );
  } else if (!isObjectId(destId)) {
    add(`\`destination.connection_id: ${destId}\` is not a valid id`);
  } else if (!(await DatabaseConnection.exists({ _id: destId, workspaceId }))) {
    add(
      `\`destination.connection_id: ${destId}\` does not name a database connection in this workspace`,
    );
  }

  // ---- the slug is identity: free, or already this flow's ----------------
  const existing = await Flow.findOne({ workspaceId, slug })
    .select("_id")
    .lean();
  if (existing) {
    // Not a problem by itself — editing a flow is the common case. Recorded so
    // a caller creating a NEW flow can tell the difference.
    problems.push({
      path,
      slug,
      reason: `note: \`${slug}\` already exists — this file EDITS that flow rather than creating one`,
    });
  }

  const blocking = problems.filter(p => !p.reason.startsWith("note:"));
  return { ok: blocking.length === 0, problems };
}

/** Validate every `flows/*.yml` in a directory listing. */
export async function validateFlowFiles(input: {
  workspaceId: string;
  files: Array<{ path: string; contents: string }>;
}): Promise<FlowValidation> {
  const problems: FlowFileProblem[] = [];
  const seen = new Map<string, string>();

  for (const f of input.files) {
    const one = await validateFlowFile({
      workspaceId: input.workspaceId,
      path: f.path,
      contents: f.contents,
    });
    problems.push(...one.problems);

    // Two files claiming one slug is not visible file-by-file, and the loser
    // would be silently overwritten by whichever the tree walk reached last.
    const slug = slugFromFlowFilePath(f.path);
    if (slug) {
      const first = seen.get(slug);
      if (first) {
        problems.push({
          path: f.path,
          slug,
          reason: `duplicate slug: \`${first}\` already claims \`${slug}\`, and the filename is the identity`,
        });
      } else {
        seen.set(slug, f.path);
      }
    }
  }

  const blocking = problems.filter(p => !p.reason.startsWith("note:"));
  return { ok: blocking.length === 0, problems };
}
