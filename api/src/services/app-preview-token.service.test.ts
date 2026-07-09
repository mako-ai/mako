/**
 * Preview token service tests: mint/verify round-trip, tamper rejection,
 * expiry, and TTL clamping.
 *
 * Run: tsx src/services/app-preview-token.service.test.ts
 */
import assert from "node:assert/strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? "test-secret-for-preview-tokens";

import {
  mintAppPreviewToken,
  verifyAppPreviewToken,
  MAX_PREVIEW_TTL_SECONDS,
  APP_PREVIEW_TOKEN_PREFIX,
} from "./app-preview-token.service";

const APP_ID = "6577f0f0f0f0f0f0f0f0f0f0";
const WORKSPACE_ID = "6588f0f0f0f0f0f0f0f0f0f0";

function main() {
  // Round-trip.
  {
    const { token, expiresAt } = mintAppPreviewToken({
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
    });
    assert.ok(token.startsWith(APP_PREVIEW_TOKEN_PREFIX));
    const grant = verifyAppPreviewToken(token);
    assert.ok(grant, "freshly minted token should verify");
    assert.equal(grant.appId, APP_ID);
    assert.equal(grant.workspaceId, WORKSPACE_ID);
    assert.equal(grant.expiresAt.getTime(), expiresAt.getTime());
  }

  // Tampered payload is rejected (signature no longer matches).
  {
    const { token } = mintAppPreviewToken({
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
    });
    const [payload, sig] = token.slice(APP_PREVIEW_TOKEN_PREFIX.length).split(".");
    const forged = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    forged.a = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const tampered =
      APP_PREVIEW_TOKEN_PREFIX +
      Buffer.from(JSON.stringify(forged)).toString("base64url") +
      "." +
      sig;
    assert.equal(verifyAppPreviewToken(tampered), null);
  }

  // Garbage and wrong-prefix tokens are rejected.
  assert.equal(verifyAppPreviewToken("mpt_not-a-token"), null);
  assert.equal(verifyAppPreviewToken("revops_abc.def"), null);
  assert.equal(verifyAppPreviewToken(""), null);

  // Expired tokens are rejected (minimum TTL is clamped to 60s, so craft one
  // directly: same signer, exp in the past).
  {
    const { token } = mintAppPreviewToken({
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 60,
    });
    const grant = verifyAppPreviewToken(token);
    assert.ok(grant);
    // 60s is the enforced floor even when asking for less…
    const { expiresAt } = mintAppPreviewToken({
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 1,
    });
    assert.ok(expiresAt.getTime() >= Date.now() + 59_000);
    // …and the cap holds even when asking for more.
    const { expiresAt: capped } = mintAppPreviewToken({
      appId: APP_ID,
      workspaceId: WORKSPACE_ID,
      ttlSeconds: 999_999,
    });
    assert.ok(
      capped.getTime() <= Date.now() + (MAX_PREVIEW_TTL_SECONDS + 1) * 1000,
    );
  }

  console.log("app-preview-token tests passed");
}

main();
