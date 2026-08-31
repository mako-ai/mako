import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mintPreviewGrant,
  mintPublishedGrant,
  resolvePreviewGrant,
} from "./preview.service";

const ws = "6846e6a01b05af0948070582";
const project = "23d9b603172c133a8427e812";
const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";

describe("published preview grants are stateless", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-0123456789abcdef";
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.SESSION_SECRET;
  });

  it("resolves a minted token with no registry — any instance can serve it", () => {
    const grant = mintPublishedGrant({
      workspaceId: ws,
      projectId: project,
      sha,
    });
    expect(grant.token.startsWith("pub.")).toBe(true);
    // A token is only ever used in a URL path segment: it must not contain "/".
    expect(grant.token).not.toContain("/");

    const resolved = resolvePreviewGrant(grant.token);
    expect(resolved).toEqual({
      token: grant.token,
      workspaceId: ws,
      projectId: project,
      publishedSha: sha,
      expiresAt: grant.expiresAt,
    });
  });

  it("rejects a token whose payload was tampered with", () => {
    const grant = mintPublishedGrant({
      workspaceId: ws,
      projectId: project,
      sha,
    });
    const [prefix, body, sig] = grant.token.split(".");
    const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    forged.s = "0000000000000000000000000000000000000000";
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString(
      "base64url",
    );
    expect(resolvePreviewGrant(`${prefix}.${forgedBody}.${sig}`)).toBeNull();
    // Damaged signature (different length) must be a null, not a throw.
    expect(resolvePreviewGrant(`${prefix}.${body}.${sig.slice(1)}`)).toBeNull();
    expect(resolvePreviewGrant("pub.garbage")).toBeNull();
    expect(resolvePreviewGrant("pub..")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const grant = mintPublishedGrant({
      workspaceId: ws,
      projectId: project,
      sha,
    });
    process.env.SESSION_SECRET = "another-secret";
    expect(resolvePreviewGrant(grant.token)).toBeNull();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T10:00:00Z"));
    const grant = mintPublishedGrant({
      workspaceId: ws,
      projectId: project,
      sha,
    });
    vi.setSystemTime(new Date("2026-08-31T10:29:00Z"));
    expect(resolvePreviewGrant(grant.token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-08-31T10:31:00Z"));
    expect(resolvePreviewGrant(grant.token)).toBeNull();
  });

  it("static grants still resolve from the in-process registry", () => {
    const grant = mintPreviewGrant({
      workspaceId: ws,
      projectId: project,
      rootDir: "/tmp/dist",
    });
    expect(grant.token.startsWith("pub.")).toBe(false);
    expect(resolvePreviewGrant(grant.token)?.rootDir).toBe("/tmp/dist");
    expect(resolvePreviewGrant("nope")).toBeNull();
  });
});
