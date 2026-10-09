/**
 * Starting a workflow from outside Mako. A webhook is turned on per workflow:
 * that makes a URL with its own secret, and a POST to it starts a run with
 * the request's JSON as input. Turning it off forgets the secret, so turning
 * it on again makes a new URL.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { Types } from "mongoose";

import { Workspace } from "../database/workspace-schema";
import { decryptString, encryptString } from "../services/crypto.service";

/** A live workflow's name, safe as a key and in a URL. A preview has no webhook. */
export const mayHaveWebhook = (name: string) =>
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) && !name.startsWith("preview_");

function urlOf(workspaceId: string, name: string, secret: string): string {
  const base = (
    process.env.API_BASE_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");
  return `${base}/api/workflows/hooks/${workspaceId}/${name}/${secret}`;
}

/** Turn a workflow's webhook on or off. Returns its URL, or null when off. */
export async function setWebhook(
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<string | null> {
  const path = `workflows.webhooks.${name}`;
  const secret = randomBytes(24).toString("hex");
  await Workspace.updateOne(
    { _id: new Types.ObjectId(workspaceId) },
    enabled
      ? { $set: { [path]: encryptString(secret) } }
      : { $unset: { [path]: "" } },
  );
  return enabled ? urlOf(workspaceId, name, secret) : null;
}

/** The workspace's webhook URLs, by workflow. */
export async function readWebhookUrls(
  workspaceId: string,
): Promise<Record<string, string>> {
  const workspace = await Workspace.findById(workspaceId)
    .select("workflows.webhooks")
    .lean();
  return Object.fromEntries(
    Object.entries(workspace?.workflows?.webhooks ?? {}).map(
      ([name, stored]) => [
        name,
        urlOf(workspaceId, name, decryptString(stored)),
      ],
    ),
  );
}

/** Whether `given` is the secret saved (encrypted) as `stored`. */
export function isWebhookSecret(
  stored: string | undefined,
  given: string,
): boolean {
  if (!stored) return false;
  const expected = Buffer.from(decryptString(stored));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
