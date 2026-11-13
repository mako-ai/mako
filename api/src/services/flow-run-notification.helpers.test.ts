import assert from "node:assert/strict";
import {
  MAX_FAILED_STEPS,
  MAX_STEP_MESSAGE_LENGTH,
  boundErrorMessage,
  boundFailedSteps,
  buildDbtSlackText,
  buildIdempotencyKey,
  deliveryRunKey,
  dbtRunDeepLink,
  isAutoDisabledDeliveryKey,
  isNotificationResourceType,
  ruleTargetsForEvent,
  scrubSecrets,
  shouldDeliverForRule,
  signWebhookBody,
  terminalTriggerFromRunEvent,
} from "./flow-run-notification.helpers";
import type { NotificationOutboundPayload } from "./flow-run-notification.types";

function testTerminalTriggerMapsSuccessAndFailure() {
  assert.equal(
    terminalTriggerFromRunEvent({
      workspaceId: "w",
      resourceType: "flow",
      resourceId: "f",
      runId: "r",
      status: "completed",
      success: true,
      completedAt: "",
    }),
    "success",
  );
  assert.equal(
    terminalTriggerFromRunEvent({
      workspaceId: "w",
      resourceType: "flow",
      resourceId: "f",
      runId: "r",
      status: "failed",
      success: false,
      completedAt: "",
    }),
    "failure",
  );
}

function testBuildIdempotencyKeyJoinsParts() {
  assert.equal(
    buildIdempotencyKey({
      resourceType: "scheduled_query",
      resourceId: "abc",
      runId: "run1",
      trigger: "success",
      channelType: "email",
      ruleId: "rule1",
    }),
    "scheduled_query:abc:run1:success:email:rule1",
  );
}

function testSignWebhookBodyIsStableHex() {
  const sig = signWebhookBody("secret", '{"a":1}');
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(signWebhookBody("secret", '{"a":1}'), sig);
}

function testResourceTypesIncludeDbt() {
  for (const type of ["scheduled_query", "flow", "dbt_job", "dbt_project"]) {
    assert.equal(isNotificationResourceType(type), true);
  }
  assert.equal(isNotificationResourceType("dbt_run"), false);
  assert.equal(isNotificationResourceType(undefined), false);
}

function testRuleTargetsAddTheProjectForDbtJobs() {
  assert.deepEqual(
    ruleTargetsForEvent({
      resourceType: "dbt_job",
      resourceId: "job1",
      projectId: "project1",
    }),
    [
      { resourceType: "dbt_job", resourceId: "job1" },
      { resourceType: "dbt_project", resourceId: "project1" },
    ],
  );
  assert.deepEqual(
    ruleTargetsForEvent({ resourceType: "dbt_job", resourceId: "job1" }),
    [{ resourceType: "dbt_job", resourceId: "job1" }],
  );
  // A flow never reaches project rules, even with a stray projectId.
  assert.deepEqual(
    ruleTargetsForEvent({
      resourceType: "flow",
      resourceId: "flow1",
      projectId: "project1",
    }),
    [{ resourceType: "flow", resourceId: "flow1" }],
  );
}

function testCadence() {
  const deliver = (
    trigger: "success" | "failure",
    previousStatus: "success" | "error" | undefined,
    options: { everyFailure?: boolean; failurePostedInStreak?: boolean } = {},
  ) =>
    shouldDeliverForRule({
      event: { resourceType: "dbt_job", previousStatus },
      trigger,
      rule: { everyFailure: options.everyFailure },
      failurePostedInStreak: options.failurePostedInStreak,
    });

  // A failure is judged on what THIS rule already posted for the streak,
  // never on the previous run's status (review B4).
  // The rule has not posted for the streak: it posts, whatever came before.
  assert.equal(deliver("failure", undefined), true);
  assert.equal(deliver("failure", "success"), true);
  assert.equal(deliver("failure", "error"), true);
  assert.equal(
    deliver("failure", "error", { failurePostedInStreak: false }),
    true,
  );
  // The rule already posted for the streak: quiet.
  assert.equal(
    deliver("failure", "error", { failurePostedInStreak: true }),
    false,
  );
  assert.equal(
    deliver("failure", "error", {
      everyFailure: false,
      failurePostedInStreak: true,
    }),
    false,
  );
  // everyFailure posts every failed run.
  assert.equal(
    deliver("failure", "error", {
      everyFailure: true,
      failurePostedInStreak: true,
    }),
    true,
  );
  assert.equal(deliver("failure", "success", { everyFailure: true }), true);
  // Recovery posts once: only the success right after a failure, in
  // completion order.
  assert.equal(deliver("success", "error"), true);
  assert.equal(deliver("success", "success"), false);
  assert.equal(deliver("success", undefined), false);
  // Neither option changes anything for successes.
  assert.equal(deliver("success", "success", { everyFailure: true }), false);
  assert.equal(
    deliver("success", "error", { failurePostedInStreak: true }),
    true,
  );

  // The auto-disabled announcement tells keys apart from failure posts.
  assert.equal(
    isAutoDisabledDeliveryKey(
      buildIdempotencyKey({
        resourceType: "dbt_job",
        resourceId: "job1",
        runId: deliveryRunKey({
          runId: "run1",
          jobDisabled: { consecutiveFailures: 10 },
        }),
        trigger: "failure",
        channelType: "slack",
        ruleId: "rule1",
      }),
    ),
    true,
  );
  assert.equal(
    isAutoDisabledDeliveryKey(
      buildIdempotencyKey({
        resourceType: "dbt_job",
        resourceId: "job1",
        runId: deliveryRunKey({ runId: "run1" }),
        trigger: "failure",
        channelType: "slack",
        ruleId: "rule1",
      }),
    ),
    false,
  );

  // Scheduled queries and flows deliver every matching run, as before.
  for (const resourceType of ["flow", "scheduled_query"] as const) {
    for (const trigger of ["success", "failure"] as const) {
      assert.equal(
        shouldDeliverForRule({
          event: { resourceType, previousStatus: "error" },
          trigger,
          rule: {},
        }),
        true,
      );
    }
  }
}

function testFailedStepsAreBounded() {
  const steps = Array.from({ length: 25 }, (_, index) => ({
    name: `model_${index}`,
    resourceType: "model",
    status: index % 2 === 0 ? "error" : "success",
    message: "x".repeat(2000),
  }));
  steps.push({
    name: "not_null_orders_id",
    resourceType: "test",
    status: "fail",
    message: "Got 3 results,\n  configured to fail if != 0",
  });
  const { failedSteps, failedStepCount } = boundFailedSteps(steps);
  assert.equal(failedStepCount, 14);
  assert.equal(failedSteps.length, MAX_FAILED_STEPS);
  assert.equal(failedSteps[0].name, "model_0");
  for (const step of failedSteps) {
    assert.ok((step.message ?? "").length <= MAX_STEP_MESSAGE_LENGTH);
  }

  const tests = boundFailedSteps([
    { name: "ok", resourceType: "model", status: "success" },
    { name: "skipped", resourceType: "model", status: "skipped" },
    {
      name: "not_null_orders_id",
      resourceType: "test",
      status: "fail",
      message: "Got 3 results,\n  configured to fail if != 0",
    },
  ]);
  assert.deepEqual(tests.failedSteps, [
    {
      name: "not_null_orders_id",
      resourceType: "test",
      status: "fail",
      message: "Got 3 results, configured to fail if != 0",
    },
  ]);
  assert.equal(boundFailedSteps([]).failedStepCount, 0);
}

function testSecretsAreScrubbed() {
  const scrubbed = scrubSecrets(
    'could not connect to postgresql://dbt_user:hunter2secret@db.example.com:5432/app password=hunter2secret token: "abc123456"',
  );
  assert.ok(!scrubbed.includes("hunter2secret"), scrubbed);
  assert.ok(!scrubbed.includes("abc123456"), scrubbed);
  assert.ok(scrubbed.includes("db.example.com"), scrubbed);
  assert.ok(
    !scrubSecrets(
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    ).includes("MIIEvQIBADANBg"),
  );
  // Ordinary dbt errors pass through unchanged.
  const plain = "Database Error in model fct_orders: column order_id not found";
  assert.equal(scrubSecrets(plain), plain);
  assert.equal(boundErrorMessage(undefined), undefined);
  assert.equal((boundErrorMessage("e".repeat(5000)) ?? "").length, 500);
}

function testDbtRunDeepLink() {
  assert.equal(
    dbtRunDeepLink({
      baseUrl: "https://app.example.com/",
      projectId: "p1",
      jobId: "j1",
      runId: "r1",
    }),
    "https://app.example.com/x/p1/job/j1?run=r1",
  );
  assert.equal(
    dbtRunDeepLink({ baseUrl: "", projectId: "p1", jobId: "j1", runId: "r1" }),
    undefined,
  );
}

function dbtPayload(
  overrides: Partial<NotificationOutboundPayload>,
): NotificationOutboundPayload {
  return {
    version: 1,
    event: "flow.run.terminal",
    trigger: "failure",
    resourceType: "dbt_job",
    resourceId: "j1",
    resourceName: "Nightly build",
    runId: "r1",
    completedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 252_000,
    triggerType: "schedule",
    workspaceId: "w1",
    deepLink: "https://app.example.com/x/p1/job/j1?run=r1",
    projectId: "p1",
    environment: "prod",
    ...overrides,
  };
}

function testDbtSlackTextFailure() {
  const text = buildDbtSlackText(
    dbtPayload({
      failedStepCount: 12,
      failedSteps: [
        {
          name: "fct_orders",
          resourceType: "model",
          status: "error",
          message: "Syntax error: expected <identifier> & got ')'",
        },
        { name: "not_null_orders_id", resourceType: "test", status: "fail" },
      ],
    }),
  );
  const lines = text.split("\n");
  // Impact first: the outcome, the job and the environment open the message.
  assert.equal(lines[0], "*dbt job failed: Nightly build* (prod)");
  assert.equal(lines[1], "12 steps failed · Scheduled run · 4 min 12 s");
  assert.equal(
    lines[2],
    "• `fct_orders (model, error)`: Syntax error: expected &lt;identifier&gt; &amp; got ')'",
  );
  assert.equal(lines[3], "• `not_null_orders_id (test, fail)`");
  assert.equal(lines[4], "…and 10 more");
  assert.equal(
    lines[5],
    "<https://app.example.com/x/p1/job/j1?run=r1|Open the run in Mako>",
  );
}

function testDbtSlackTextRunErrorAndRecovery() {
  const noSteps = buildDbtSlackText(
    dbtPayload({
      failedSteps: [],
      failedStepCount: 0,
      errorMessage: "Run exceeded its time limit",
      triggerType: "manual",
      durationMs: undefined,
    }),
  );
  assert.ok(noSteps.includes("\nManual run\n"), noSteps);
  assert.ok(noSteps.includes("Error: Run exceeded its time limit"), noSteps);

  const recovered = buildDbtSlackText(
    dbtPayload({ trigger: "success", recovered: true }),
  );
  assert.equal(
    recovered,
    [
      "*dbt job recovered: Nightly build* (prod)",
      "Scheduled run succeeded after a failed run · 4 min 12 s",
      "<https://app.example.com/x/p1/job/j1?run=r1|Open the run in Mako>",
    ].join("\n"),
  );

  // Slack rejects a section over 3000 characters; the link survives the cut.
  const long = buildDbtSlackText(
    dbtPayload({
      failedStepCount: 10,
      failedSteps: Array.from({ length: 10 }, (_, index) => ({
        name: `model_${index}`,
        resourceType: "model",
        status: "error",
        message: "<".repeat(300),
      })),
    }),
  );
  assert.ok(long.length <= 3000, String(long.length));
  assert.ok(long.endsWith("|Open the run in Mako>"));
}

function main() {
  testTerminalTriggerMapsSuccessAndFailure();
  testBuildIdempotencyKeyJoinsParts();
  testSignWebhookBodyIsStableHex();
  testResourceTypesIncludeDbt();
  testRuleTargetsAddTheProjectForDbtJobs();
  testCadence();
  testFailedStepsAreBounded();
  testSecretsAreScrubbed();
  testDbtRunDeepLink();
  testDbtSlackTextFailure();
  testDbtSlackTextRunErrorAndRecovery();
}

main();
