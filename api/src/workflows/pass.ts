/**
 * A workflow pass: what one step of one deployed run calls Mako with.
 *
 * Deployed workflows of a workspace share one pod, and the pod holds one key
 * (the worker key, worker-key.ts). Workflow code never sees that key: the
 * dispatcher (worker.mjs), which holds it and runs no workflow code, asks
 * Mako for a pass for each step it runs, and the step program (step.mjs),
 * running as that workflow's own user, calls Mako with the pass alone.
 *
 * A pass names its workspace, workflow, run and step, and the worker key it
 * was made for. Mako believes the workflow a pass names, and nothing a
 * request says about itself (no X-Mako-Workflow, no X-Mako-Run): that is what
 * lets a writers or live readers list name one workflow. A pass stops
 * working when its run stops executing (checked on every use, runs.ts
 * `runStartedBy`), when the worker key is replaced, and after PASS_MAX_AGE_MS
 * at the latest.
 *
 * Wire format: `mwp_<base64url JSON>.<base64url HMAC-SHA256>`, signed with a
 * key derived from ENCRYPTION_KEY. Nothing is stored: a pass is checked by its
 * signature, its key and its run.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export const PASS_PREFIX = "mwp_";
/** The longest a pass lives, however long its run takes. */
export const PASS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface WorkflowPass {
  workspaceId: string;
  workflow: string;
  runId: string;
  step?: string;
  /** The worker key it was made for (`keyIdOf` its hash). */
  keyId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

interface Payload {
  v: 1;
  ws: string;
  wf: string;
  run: string;
  step?: string;
  kid: string;
  exp: number;
}

function signingKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  return Buffer.from(
    hkdfSync("sha256", secret, "mako", "workflow-pass v1", 32),
  );
}

const sign = (body: string) =>
  createHmac("sha256", signingKey()).update(body).digest("base64url");

/** The part of a worker key's hash a pass names it by. */
export const keyIdOf = (keyHash: string) => keyHash.slice(0, 16);

export const isPassToken = (token: string) => token.startsWith(PASS_PREFIX);

export function mintPass(
  pass: Omit<WorkflowPass, "expiresAt">,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + PASS_MAX_AGE_MS;
  const payload: Payload = {
    v: 1,
    ws: pass.workspaceId,
    wf: pass.workflow,
    run: pass.runId,
    ...(pass.step ? { step: pass.step } : {}),
    kid: pass.keyId,
    exp: expiresAt,
  };
  const body = `${PASS_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return { token: `${body}.${sign(body)}`, expiresAt };
}

/** The pass `token` carries, or null when it is not one Mako signed or it expired. */
export function readPass(token: string, now = Date.now()): WorkflowPass | null {
  if (!isPassToken(token)) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let payload: Payload;
  try {
    payload = JSON.parse(
      Buffer.from(body.slice(PASS_PREFIX.length), "base64url").toString(),
    ) as Payload;
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    typeof payload.ws !== "string" ||
    typeof payload.wf !== "string" ||
    typeof payload.run !== "string" ||
    typeof payload.kid !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    return null;
  }
  return {
    workspaceId: payload.ws,
    workflow: payload.wf,
    runId: payload.run,
    ...(typeof payload.step === "string" ? { step: payload.step } : {}),
    keyId: payload.kid,
    expiresAt: payload.exp,
  };
}
