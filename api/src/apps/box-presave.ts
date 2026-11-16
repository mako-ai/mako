/**
 * Pre-save: copy every session box's box-only work to rescue refs on the
 * server before the box is left behind (the E2B workspace move).
 *
 * Why this exists. The box IS the working copy (box.ts). Agent turns and
 * editor saves commit and push, but some work lives only in the box:
 * - edits made in the terminal or with app_bash outside the apps a turn
 *   touched (the end-of-turn commit is scoped to touched apps on purpose);
 * - an end-of-turn commit that failed (commitAgentTurn never throws);
 * - commits on a branch that was never pushed, commits on a detached HEAD,
 *   and stashes.
 * Boxes are found by `makoAppsSessionKey` metadata in ONE E2B account. When
 * Mako switches to another account's key it clones fresh boxes from the
 * server, and that work stays behind.
 *
 * Every rule about what may leave a box lives in box/rescue-commit.ts (the
 * helper the idle-box reaper uses too): origin must be this workspace's
 * endpoint, "on the server" means a fresh fetch into SERVER_REFS, every
 * unpushed ancestor is scanned before any push, secrets and big files never
 * travel, nothing is forced, pulled or merged. This file adds only what the
 * reaper does not need: pushing OTHER local branches and stashes to rescue
 * refs of their own, so the worktree rescue can then run.
 *
 * Refs it writes (all new names under `mako-presave/<userId>/<date>`):
 *   <base>                 the working tree and HEAD's unpushed commits
 *                          (detached or not), via rescueCommit
 *   <base>-branch/<name>   another local branch with commits the server lacks
 *   <base>-stash-<sha7>    each stash, named by its commit
 * Siblings rather than children of <base>: git cannot hold a ref and a
 * directory of refs under one name.
 *
 * The orchestration takes its box operations as a parameter so it can be
 * tested without E2B; rescueBox runs for real against a local bare repo in
 * box-presave.git.test.ts; scripts/e2b-presave-sessions.ts wires E2B.
 */
import {
  excludedBecause,
  inspectScript as rescueInspectScript,
  parseChanges,
  parseInspection as parseRescueInspection,
  pushRescueBranch,
  rescueBranchName,
  rescueCommit,
  scanUnpushed,
  serverRefsScript,
  originScript,
  changesScript,
  SERVER_REFS,
  type BoxRun,
  type RescueResult,
} from "./box/rescue-commit";

export type BoxState = "running" | "paused";

export interface ListedBox {
  sandboxId: string;
  sessionKey: string;
  state: BoxState;
}

export interface PathInfo {
  path: string;
  /** Bytes; -1 deleted, -2 index-only (staged, then deleted). */
  size: number;
  /** null = it travels; otherwise excludedBecause()'s reason. */
  excluded: string | null;
}

export interface BoxInspection {
  hasRepo: boolean;
  origin: string | null;
  /** null = detached HEAD. */
  branch: string | null;
  inProgress: string[];
  /** Changed, staged or untracked paths, capped at INSPECT_PATH_CAP. */
  paths: PathInfo[];
  pathsTotal: number;
  stashes: number;
  /** Local branches (current one included) with commits on no remote. */
  unpushed: string[];
  /** Commits reachable from HEAD on no remote. */
  headUnpushed: number;
}

export interface RefRescue {
  ref: string;
  status: "pushed" | "unchanged" | "blocked" | "failed";
  commitOid?: string;
  detail?: string;
}

export interface BoxRescue {
  /** null when the box's origin was refused before anything else. */
  worktree: RescueResult;
  refs: RefRescue[];
}

export interface RescuePlan {
  workspaceId: string;
  userId: string;
  now: Date;
  expectedOrigin: string;
}

export interface PresaveOps {
  listBoxes(): Promise<ListedBox[]>;
  /** Attach to this exact box (resumes a paused one). Never creates. */
  open(box: ListedBox): Promise<void>;
  /** Read-only, for the dry run. */
  inspect(box: ListedBox): Promise<BoxInspection>;
  /** rescueBox over this box (fresh token first). */
  rescue(box: ListedBox, plan: RescuePlan): Promise<BoxRescue>;
  /** Put a box this pass resumed back to sleep. */
  pause(box: ListedBox): Promise<void>;
}

export type PresaveAction =
  | "skipped"
  | "foreign-origin"
  | "clean"
  | "would-save"
  | "saved"
  | "manual"
  | "error";

export interface PresaveRow {
  sessionKey: string;
  sandboxId: string;
  state: BoxState;
  action: PresaveAction;
  origin?: string | null;
  branch?: string | null;
  inProgress?: string[];
  paths?: PathInfo[];
  pathsTotal?: number;
  unpushedBranches?: string[];
  stashes?: number;
  headUnpushed?: number;
  /** New refs or commits pushed by this run. */
  changed?: boolean;
  /** The worktree rescue's answer (box/rescue-commit.ts). */
  worktree?: "pushed" | "unchanged" | "clean" | "manual";
  rescueBranch?: string;
  commitOid?: string;
  excluded?: string[];
  refs?: RefRescue[];
  note?: string;
}

export interface PresaveOptions {
  apply: boolean;
  /** e.g. https://app.mako.ai — a box whose origin is not under it is skipped. */
  originBase: string;
  /** Also visit running boxes (default: paused only). */
  includeRunning?: boolean;
  /** Visit only these session keys. */
  only?: string[];
  /** Stop after this many visited boxes. */
  limit?: number;
  now?: () => Date;
  onRow?: (row: PresaveRow) => void;
}

export const INSPECT_PATH_CAP = 2000;

const OBJECT_ID = /^[0-9a-f]{24}$/;

/** The publish box builds pinned shas: nothing in it is a person's work. */
export const PUBLISH_SESSION_USER = "publish";

/**
 * `<workspaceId>:<userId>` for a person's session box; null for anything
 * else (`<ws>:publish`, `connector-sync:<ws>`, `connector-build:<ws>`).
 */
export function parseSessionKey(
  sessionKey: string,
): { workspaceId: string; userId: string } | null {
  const at = sessionKey.indexOf(":");
  if (at <= 0) return null;
  const workspaceId = sessionKey.slice(0, at);
  const userId = sessionKey.slice(at + 1);
  if (!OBJECT_ID.test(workspaceId) || !userId) return null;
  if (userId === PUBLISH_SESSION_USER) return null;
  return { workspaceId, userId };
}

/** The only origin a production session box for this workspace may have. */
export function expectedOrigin(
  originBase: string,
  workspaceId: string,
): string {
  return `${originBase.replace(/\/+$/, "")}/api/apps-git/${workspaceId}.git`;
}

/**
 * The dry run's read-only view. Counts against local tracking refs (the dry
 * run has no credential to fetch with), so "unpushed" is an estimate here;
 * --apply always measures against a fresh fetch into SERVER_REFS.
 */
export function dryRunInspectScript(root: string): string {
  const q = `'${root.replace(/'/g, `'\\''`)}'`;
  return [
    `cd ${q} 2>/dev/null && test -d .git || { echo repo=no; exit 0; }`,
    "echo repo=yes",
    'echo "origin=$(git remote get-url origin 2>/dev/null)"',
    'echo "branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"',
    "gd=$(git rev-parse --git-dir)",
    'for s in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do [ -e "$gd/$s" ] && echo "inprogress=$s"; done',
    '{ [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; } && echo inprogress=REBASE',
    'echo "stashes=$(git stash list 2>/dev/null | wc -l | tr -d " ")"',
    'echo "headunpushed=$(git rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"',
    'git for-each-ref --format="%(refname:short)" refs/heads | while IFS= read -r b; do n=$(git rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null || echo 0); [ "$n" -gt 0 ] && echo "unpushed=$b"; done',
    "echo PATHS",
  ].join("\n");
}

export function parseDryRunInspection(
  head: string,
  changes: string,
): BoxInspection {
  const out: BoxInspection = {
    hasRepo: false,
    origin: null,
    branch: null,
    inProgress: [],
    paths: [],
    pathsTotal: 0,
    stashes: 0,
    unpushed: [],
    headUnpushed: 0,
  };
  for (const line of head.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "repo") out.hasRepo = value === "yes";
    else if (key === "origin") out.origin = value || null;
    else if (key === "branch") out.branch = value || null;
    else if (key === "inprogress" && value) out.inProgress.push(value);
    else if (key === "stashes") out.stashes = Number(value) || 0;
    else if (key === "headunpushed") out.headUnpushed = Number(value) || 0;
    else if (key === "unpushed" && value) out.unpushed.push(value);
  }
  const all = parseChanges(changes);
  out.pathsTotal = all.length;
  out.paths = all.slice(0, INSPECT_PATH_CAP).map(({ path, size }) => ({
    path,
    size,
    excluded: excludedBecause(path, size),
  }));
  return out;
}

/** The dry run's inspection over a BoxRun: two read-only commands. */
export async function dryRunInspect(
  run: BoxRun,
  root: string,
): Promise<BoxInspection> {
  const head = await run(dryRunInspectScript(root), { timeoutMs: 60_000 });
  if (!/^repo=yes$/m.test(head.stdout)) {
    return parseDryRunInspection(head.stdout, "");
  }
  const changes = await run(changesScript(root), { timeoutMs: 120_000 });
  return parseDryRunInspection(head.stdout, changes.stdout);
}

const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Everything --apply does to one box, on box/rescue-commit.ts's rules:
 * 1. Refuse unless the origin is exactly `expectedOrigin`.
 * 2. Fresh credential, then a fresh fetch of the server's branches.
 * 3. Each OTHER local branch with commits the server lacks, and each stash:
 *    scanUnpushed (every ancestor), then pushRescueBranch to its own ref.
 *    A ref the server already holds at the same commit is `unchanged`.
 * 4. rescueCommit for the working tree and HEAD's unpushed commits, with
 *    stashes marked handled only when every stash reached the server.
 */
export async function rescueBox(
  run: BoxRun,
  input: {
    root: string;
    userId: string;
    now: Date;
    author?: { name?: string; email?: string };
    expectedOrigin: string;
    prepareRemote?: () => Promise<void>;
    message?: string;
  },
): Promise<BoxRescue> {
  const { root } = input;
  const refs: RefRescue[] = [];
  const base = rescueBranchName(input.userId, input.now);

  const origin = await run(originScript(root), { timeoutMs: 30_000 });
  const where = parseRescueInspection(origin.stdout);
  const ok =
    origin.exitCode === 0 &&
    /^repo=yes$/m.test(origin.stdout) &&
    where.origin === input.expectedOrigin &&
    input.expectedOrigin !== "";
  if (ok) {
    await input.prepareRemote?.();
    const fetched = await run(serverRefsScript(root), { timeoutMs: 120_000 });
    if (fetched.exitCode === 0) {
      const seen = parseRescueInspection(
        (await run(rescueInspectScript(root), { timeoutMs: 60_000 })).stdout,
      );
      const listed = await run(
        `cd ${sh(root)} && { for b in ${seen.otherUnpushed.map(b => sh(b)).join(" ")}; do echo "branch $(git rev-parse "refs/heads/$b") $b"; done; git stash list --format="stash %H" 2>/dev/null; }`,
        { timeoutMs: 60_000 },
      );
      const targets: Array<{ sha: string; ref: string }> = [];
      for (const line of listed.stdout.split("\n")) {
        const m = /^(branch|stash) ([0-9a-f]{40})(?: (.+))?$/.exec(line.trim());
        if (!m?.[2]) continue;
        targets.push({
          sha: m[2],
          ref:
            m[1] === "branch"
              ? `${base}-branch/${m[3] ?? ""}`
              : `${base}-stash-${m[2].slice(0, 7)}`,
        });
      }
      for (const { sha, ref } of targets) {
        refs.push(await pushRef(run, root, sha, ref));
      }
    }
  }
  const stashRefs = refs.filter(r => /-stash-[0-9a-f]{7}$/.test(r.ref));
  const worktree = await rescueCommit({
    run,
    root,
    userId: input.userId,
    now: input.now,
    author: input.author,
    expectedOrigin: input.expectedOrigin,
    // The credential was refreshed above; rescueCommit fetches the server's
    // branches again, so the refs just pushed count as on the server.
    prepareRemote: ok ? undefined : input.prepareRemote,
    stashesHandled:
      stashRefs.length > 0 &&
      stashRefs.every(r => r.status === "pushed" || r.status === "unchanged"),
    message: input.message,
  });
  return { worktree, refs };
}

async function pushRef(
  run: BoxRun,
  root: string,
  sha: string,
  ref: string,
): Promise<RefRescue> {
  const scan = await scanUnpushed(run, root, sha);
  if (scan.status === "error") {
    return { ref, status: "failed", detail: scan.reason };
  }
  if (scan.status === "blocked") {
    return { ref, status: "blocked", detail: scan.path };
  }
  const held = await run(
    `cd ${sh(root)} && git rev-parse -q --verify ${sh(`${SERVER_REFS}/${ref}`)} 2>/dev/null || true`,
    { timeoutMs: 30_000 },
  );
  if (held.stdout.trim() === sha) {
    return { ref, status: "unchanged", commitOid: sha };
  }
  const pushed = await pushRescueBranch(run, root, sha, ref);
  return pushed.status === "pushed"
    ? { ref: pushed.branch, status: "pushed", commitOid: sha }
    : { ref, status: "failed", detail: pushed.reason };
}

/** Never let a token-shaped string or URL credentials reach a report. */
export function scrub(text: string): string {
  return text
    .replace(/mgt_[A-Za-z0-9._-]+/g, "mgt_[redacted]")
    .replace(/e2b_[A-Za-z0-9]+/g, "e2b_[redacted]")
    .replace(/\/\/[^/@\s]+@/g, "//[redacted]@");
}

function errorText(error: unknown): string {
  return scrub(error instanceof Error ? error.message : String(error)).slice(
    0,
    300,
  );
}

/** `path (reason)` from rescueCommit's excluded list. */
function excludedReason(entry: string): string {
  return /\(([^()]*)\)$/.exec(entry)?.[1] ?? "";
}

export async function presaveSessions(
  ops: PresaveOps,
  options: PresaveOptions,
): Promise<{ rows: PresaveRow[]; totals: Record<PresaveAction, number> }> {
  const now = options.now ?? (() => new Date());
  const only = options.only?.length ? new Set(options.only) : null;
  const rows: PresaveRow[] = [];
  const emit = (row: PresaveRow) => {
    rows.push(row);
    options.onRow?.(row);
  };
  let visited = 0;

  for (const box of await ops.listBoxes()) {
    const base = {
      sessionKey: box.sessionKey,
      sandboxId: box.sandboxId,
      state: box.state,
    };
    if (only && !only.has(box.sessionKey)) continue;
    const session = parseSessionKey(box.sessionKey);
    if (!session) {
      emit({ ...base, action: "skipped", note: "not a person's session box" });
      continue;
    }
    if (box.state === "running" && !options.includeRunning) {
      emit({
        ...base,
        action: "skipped",
        note: "running (pass --include-running once Mako no longer uses it)",
      });
      continue;
    }
    if (options.limit !== undefined && visited >= options.limit) break;
    visited += 1;

    try {
      await ops.open(box);
      const seen = await ops.inspect(box);
      if (!seen.hasRepo) {
        emit({ ...base, action: "clean", note: "no checkout in the box" });
        continue;
      }
      const origin = expectedOrigin(options.originBase, session.workspaceId);
      if (seen.origin !== origin) {
        // A preview or laptop box (or one pointed elsewhere by hand): its
        // work belongs to another server. Never re-point it, never push.
        emit({
          ...base,
          action: "foreign-origin",
          origin: seen.origin ? scrub(seen.origin) : null,
          note: `origin is not ${origin}`,
        });
        continue;
      }
      const facts = {
        branch: seen.branch,
        inProgress: seen.inProgress,
        paths: seen.paths,
        pathsTotal: seen.pathsTotal,
        unpushedBranches: seen.unpushed,
        stashes: seen.stashes,
        headUnpushed: seen.headUnpushed,
      };
      const boxOnly =
        seen.pathsTotal > 0 ||
        seen.unpushed.length > 0 ||
        seen.stashes > 0 ||
        seen.headUnpushed > 0;
      if (!options.apply) {
        emit({ ...base, ...facts, action: boxOnly ? "would-save" : "clean" });
        continue;
      }

      // --apply always runs the rescue: the dry run's "unpushed" is an
      // estimate, and rescueBox answers against a fresh fetch.
      const { worktree, refs } = await ops.rescue(box, {
        ...session,
        now: now(),
        expectedOrigin: origin,
      });
      const problems: string[] = [];
      if (worktree.status === "manual") {
        problems.push(`worktree: ${scrub(worktree.reason)}`);
      }
      for (const r of refs) {
        if (r.status === "blocked") {
          problems.push(
            `${r.ref}: unpushed history holds ${r.detail ?? "a blocked file"}`,
          );
        } else if (r.status === "failed") {
          problems.push(`${r.ref}: ${scrub(r.detail ?? "push failed")}`);
        }
      }
      // A left-out file is work that did NOT reach the server. Build output
      // is regenerable; anything else (a secret, a 12 MB CSV, a file only the
      // index held) needs a person.
      const leftOut = worktree.excluded.filter(
        e => excludedReason(e) !== "excluded directory",
      );
      if (worktree.status !== "manual" && leftOut.length > 0) {
        problems.push(
          `${leftOut.length} file(s) left out: ${leftOut.slice(0, 5).join(", ")}`,
        );
      }
      const saved = worktree.status === "saved" ? worktree : undefined;
      const changed =
        Boolean(saved && !saved.unchanged) ||
        refs.some(r => r.status === "pushed");
      const action: PresaveAction =
        problems.length > 0
          ? "manual"
          : worktree.status === "clean" && refs.length === 0
            ? "clean"
            : "saved";
      emit({
        ...base,
        ...facts,
        action,
        changed,
        worktree: saved
          ? saved.unchanged
            ? "unchanged"
            : "pushed"
          : worktree.status === "clean"
            ? "clean"
            : "manual",
        ...(saved
          ? { rescueBranch: saved.branch, commitOid: saved.commitOid }
          : {}),
        excluded: worktree.excluded,
        refs,
        ...(problems.length > 0 ? { note: problems.join("; ") } : {}),
      });
    } catch (error) {
      emit({ ...base, action: "error", note: errorText(error) });
    } finally {
      // Only a box this pass woke goes back to sleep; a running box is
      // someone's live session and stays as it was. Attempted even when
      // open failed part-way: a resume can succeed before a probe fails.
      if (box.state === "paused") {
        await ops.pause(box).catch(() => undefined);
      }
    }
  }

  const totals: Record<PresaveAction, number> = {
    skipped: 0,
    "foreign-origin": 0,
    clean: 0,
    "would-save": 0,
    saved: 0,
    manual: 0,
    error: 0,
  };
  for (const row of rows) totals[row.action] += 1;
  return { rows, totals };
}
