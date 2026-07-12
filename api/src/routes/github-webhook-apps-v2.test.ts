import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const handlePush = vi.hoisted(() => vi.fn());

vi.mock("../integrations/github/config", () => ({
  getGitHubAppWebhookSecret: () => "test-secret",
  isGitHubAppUserAuthConfigured: () => false,
}));
vi.mock("../apps-v2/github-delivery.service", () => ({
  enqueueAppsV2GitHubPushDelivery: enqueue,
}));
vi.mock("../dbt/dbt-ci.service", () => ({
  handlePushEvent: handlePush,
  handlePullRequestEvent: vi.fn(),
}));

import { githubRoutes } from "./github.routes";

function signedRequest(payload: object, headers: Record<string, string> = {}) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", "test-secret")
    .update(raw)
    .digest("hex")}`;
  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": signature,
      ...headers,
    },
    body: raw,
  });
}

const payload = {
  ref: "refs/heads/main",
  after: "a".repeat(40),
  repository: { name: "app", owner: { login: "mako" } },
  installation: { id: 42 },
};

beforeEach(() => {
  enqueue.mockReset();
  handlePush.mockReset();
  enqueue.mockResolvedValue({ enqueued: true, duplicate: false });
  handlePush.mockResolvedValue(undefined);
});

describe("Apps v2 GitHub webhook intake", () => {
  it("skips Apps v2 enqueue without delivery or installation identity", async () => {
    const missingDelivery = await githubRoutes.request(signedRequest(payload));
    expect(missingDelivery.status).toBe(202);
    expect(enqueue).not.toHaveBeenCalled();

    const missingInstallation = await githubRoutes.request(
      signedRequest(
        { ...payload, installation: undefined },
        { "x-github-delivery": "delivery-1" },
      ),
    );
    expect(missingInstallation.status).toBe(202);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("durably enqueues identified Apps v2 pushes before acknowledging", async () => {
    const response = await githubRoutes.request(
      signedRequest(payload, { "x-github-delivery": "delivery-2" }),
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      deliveryId: "delivery-2",
      installationId: 42,
      owner: "mako",
      repo: "app",
      branch: "main",
      after: "a".repeat(40),
    });
  });

  it("returns a retryable error when durable enqueue fails", async () => {
    enqueue.mockRejectedValueOnce(new Error("queue unavailable"));

    const response = await githubRoutes.request(
      signedRequest(payload, { "x-github-delivery": "delivery-3" }),
    );

    expect(response.status).toBe(503);
  });
});
