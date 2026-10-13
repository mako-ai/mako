/**
 * What starts a workflow without a person. A workflow is deployed with its
 * triggers off and runs only when started by hand; an admin activates it,
 * and its schedule and webhook go live. A webhook is turned on per workflow:
 * that makes a URL with its own secret, and a POST to it starts a run with
 * the request's JSON as input; with `?sandbox=<user>` it starts that
 * person's sandbox version instead (the test URL, active or not). Turning
 * it off forgets the secret, so turning it on again makes a new URL.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { decryptString, encryptString } from "../services/crypto.service";
import { HatchetError } from "./hatchet";

type Webhooks = Record<string, string> | undefined;

/** The name becomes a key, a URL segment and a Hatchet workflow name. */
function checkName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new HatchetError(`Invalid workflow: ${name}`, 400);
  }
}

function urlOf(workspaceId: string, name: string, secret: string): string {
  const base = (
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");
  return `${base}/api/workflows/hooks/${workspaceId}/${name}/${secret}`;
}

/**
 * Change what starts a workflow: `active` turns its schedule and webhook on
 * or off (the worker registers it again), `webhook` adds a webhook (a new
 * URL, returned) or removes it (null). What is left out stays as it is.
 */
export async function setTriggers(
  workspaceId: string,
  name: string,
  change: { active?: boolean; webhook?: boolean },
): Promise<{ webhookUrl?: string | null }> {
  checkName(name);
  const path = `workflows.webhooks.${name}`;
  const secret = randomBytes(24).toString("hex");
  const update = {
    ...(change.active === true && { $addToSet: { "workflows.active": name } }),
    ...(change.active === false && { $pull: { "workflows.active": name } }),
    ...(change.webhook === true && { $set: { [path]: encryptString(secret) } }),
    ...(change.webhook === false && { $unset: { [path]: "" } }),
  };
  if (Object.keys(update).length > 0) {
    await Workspace.updateOne({ _id: new Types.ObjectId(workspaceId) }, update);
  }
  return change.webhook === undefined
    ? {}
    : { webhookUrl: change.webhook ? urlOf(workspaceId, name, secret) : null };
}

/** The workspace's webhook URLs, by workflow. */
export function webhookUrls(
  workspaceId: string,
  webhooks: Webhooks,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(webhooks ?? {}).map(([name, stored]) => [
      name,
      urlOf(workspaceId, name, decryptString(stored)),
    ]),
  );
}

/** Whether `given` is the secret of the webhook turned on for `name`. */
export function isWebhookSecret(
  webhooks: Webhooks,
  name: string,
  given: string,
): boolean {
  // Own keys only: `constructor` is not a workflow.
  if (!webhooks || !Object.hasOwn(webhooks, name)) return false;
  const expected = Buffer.from(decryptString(webhooks[name]));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
