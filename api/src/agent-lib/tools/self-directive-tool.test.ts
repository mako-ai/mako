/**
 * Unit tests for the self-directive (persistent workspace memory) update
 * engine.
 *
 * Regression coverage for the recurring "Self-directive would exceed the
 * 10000 character limit" failure loop: once the directive filled up, every
 * session's first update failed and burned a turn on recovery. The engine now
 * reports remaining capacity on reads/writes, warns before the cap is hit,
 * and rejects overflows with one-step recovery instructions.
 *
 * Run: tsx src/agent-lib/tools/self-directive-tool.test.ts
 */
import assert from "node:assert/strict";
import {
  MAX_SELF_DIRECTIVE_LENGTH,
  applySelfDirectiveOperation,
  buildSkillPointer,
  dedupeAgainstDirective,
  findMissingSkillPointers,
  missingSkillPointersError,
  planArchiveSection,
  skillPointers,
  selfDirectiveCompactionWarning,
  selfDirectiveUsage,
} from "./self-directive-tool";

const CURRENT = [
  "# Rules",
  "- Always filter by workspace_id",
  "- Amounts are in cents",
].join("\n");

// --- set overwrites --------------------------------------------------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "set",
    content: "fresh",
  });
  assert.deepEqual(r, { ok: true, value: "fresh" });
}

// --- append / prepend join with newline, and skip it when empty ------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "append",
    content: "- New rule",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, CURRENT + "\n- New rule");

  const empty = applySelfDirectiveOperation("", {
    operation: "append",
    content: "- Only rule",
  });
  assert.deepEqual(empty, { ok: true, value: "- Only rule" });

  const pre = applySelfDirectiveOperation(CURRENT, {
    operation: "prepend",
    content: "# Priority",
  });
  assert.equal(pre.ok, true);
  if (pre.ok) assert.equal(pre.value, "# Priority\n" + CURRENT);
}

// --- find_and_replace: first occurrence only, literal (no regex) -----------
{
  const r = applySelfDirectiveOperation("a.c a.c", {
    operation: "find_and_replace",
    find: "a.c",
    replace: "X",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "X a.c");

  const miss = applySelfDirectiveOperation(CURRENT, {
    operation: "find_and_replace",
    find: "not present",
    replace: "X",
  });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /Text not found/);
}

// --- insert_after ----------------------------------------------------------
{
  const r = applySelfDirectiveOperation(CURRENT, {
    operation: "insert_after",
    after: "# Rules",
    content: "- Inserted",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.match(r.value, /# Rules\n- Inserted\n- Always filter/);

  const miss = applySelfDirectiveOperation(CURRENT, {
    operation: "insert_after",
    after: "missing anchor",
    content: "x",
  });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /Anchor text not found/);
}

// --- delete_section removes text and collapses blank runs ------------------
{
  const r = applySelfDirectiveOperation("a\n\nremove me\n\nb", {
    operation: "delete_section",
    find: "remove me",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, "a\n\nb");
}

// --- missing required fields fail without touching content -----------------
{
  for (const [operation, expected] of [
    ["set", "content"],
    ["append", "content"],
    ["prepend", "content"],
    ["find_and_replace", "find"],
    ["insert_after", "after"],
    ["delete_section", "find"],
  ] as const) {
    const r = applySelfDirectiveOperation(CURRENT, { operation });
    assert.equal(r.ok, false, operation);
    if (!r.ok) assert.match(r.error, new RegExp(`'${expected}' is required`));
  }
}

// --- overflow: rejected with one-step recovery guidance --------------------
{
  const nearlyFull = "x".repeat(MAX_SELF_DIRECTIVE_LENGTH - 10);
  const r = applySelfDirectiveOperation(nearlyFull, {
    operation: "append",
    content: "y".repeat(100),
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    // Actionable numbers: overage, current size, free space.
    assert.match(r.error, /91 over the 10000 limit/);
    assert.match(r.error, /current: 9990 chars/);
    assert.match(r.error, /10 free/);
    // And explicit recovery instructions (no blind retry).
    assert.match(r.error, /Do NOT retry the same content/);
    assert.match(r.error, /'set' with a compacted/);
  }

  // Exactly at the limit still succeeds.
  const exact = applySelfDirectiveOperation("", {
    operation: "set",
    content: "x".repeat(MAX_SELF_DIRECTIVE_LENGTH),
  });
  assert.equal(exact.ok, true);
}

// --- usage stats -----------------------------------------------------------
{
  assert.deepEqual(selfDirectiveUsage(9990), {
    length: 9990,
    limit: MAX_SELF_DIRECTIVE_LENGTH,
    remaining: 10,
  });
  // Legacy over-limit content never reports negative remaining space.
  assert.equal(selfDirectiveUsage(MAX_SELF_DIRECTIVE_LENGTH + 5).remaining, 0);
}

// --- compaction warning fires at 80%, not below ----------------------------
{
  assert.equal(selfDirectiveCompactionWarning(7999), undefined);
  const warning = selfDirectiveCompactionWarning(8000);
  assert.ok(warning);
  assert.match(warning, /80% full/);
  assert.match(warning, /archive_section/);

  const nearCap = selfDirectiveCompactionWarning(9990);
  assert.ok(nearCap);
  assert.match(nearCap, /9990\/10000/);
}

// --- archive_section planning: pointer replaces section, spacing cleaned ---
{
  const directive = [
    "# Rules",
    "- workspace_id filter always",
    "",
    "## Stripe quirks",
    "- amounts in cents",
    "- refunds are negative rows",
    "",
    "- prefer CTEs",
  ].join("\n");
  const section = [
    "## Stripe quirks",
    "- amounts in cents",
    "- refunds are negative rows",
  ].join("\n");

  const plan = planArchiveSection(directive, {
    find: section,
    skillName: "stripe_quirks",
    loadWhen: "querying Stripe charges or refunds",
    keepPointer: true,
  });
  assert.equal(plan.ok, true);
  if (plan.ok) {
    assert.equal(plan.section, section);
    assert.match(
      plan.newValue,
      /- → skill 'stripe_quirks': querying Stripe charges or refunds/,
    );
    assert.doesNotMatch(plan.newValue, /amounts in cents/);
    // Surrounding content intact, no triple blank lines.
    assert.match(plan.newValue, /workspace_id filter always/);
    assert.match(plan.newValue, /prefer CTEs/);
    assert.doesNotMatch(plan.newValue, /\n{3,}/);
  }

  // keepPointer: false removes the section without a trace.
  const silent = planArchiveSection(directive, {
    find: section,
    skillName: "stripe_quirks",
    loadWhen: "querying Stripe",
    keepPointer: false,
  });
  assert.equal(silent.ok, true);
  if (silent.ok) assert.doesNotMatch(silent.newValue, /skill 'stripe_quirks'/);

  // Section not present → error, nothing planned.
  const miss = planArchiveSection(directive, {
    find: "## Not there",
    skillName: "x",
    loadWhen: "y",
    keepPointer: true,
  });
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /Text not found/);
}

// --- archiving must actually shrink an at-cap directive ---------------------
{
  const atCap = "x".repeat(MAX_SELF_DIRECTIVE_LENGTH);
  const plan = planArchiveSection(atCap, {
    find: "xx",
    skillName: "tiny",
    loadWhen: "a".repeat(200),
    keepPointer: true,
  });
  // Removing 2 chars but inserting a ~115-char pointer would overflow.
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.error, /archive a larger section/);
}

// --- pointer builder truncates long triggers -------------------------------
{
  assert.equal(
    buildSkillPointer("stripe_quirks", "querying Stripe"),
    "- → skill 'stripe_quirks': querying Stripe",
  );
  const long = buildSkillPointer("s", "z".repeat(200));
  assert.ok(long.length < 130);
  assert.match(long, /\.\.\.$/);
}

// Async checks; awaited before the explicit exit at the bottom.
const pending: Promise<void>[] = [];

// --- skill pointers: paths, load_skill calls, archive pointers -------------
{
  assert.deepEqual(
    skillPointers(
      [
        "- Read skills/dbt-ci/SKILL.md before a PR.",
        "- load_skill(\"apps\") first; load_skill({ name: 'charts' }) too.",
        "- → skill 'stripe_quirks': querying Stripe",
        "- Claude Code reads .claude/skills/local-only/SKILL.md.",
      ].join("\n"),
    ).sort(),
    ["apps", "charts", "dbt-ci", "stripe_quirks"],
  );
  assert.deepEqual(skillPointers("no pointers here"), []);
}

// --- a pointer to a skill that does not exist is refused -------------------
{
  const known = new Set(["apps", "dbt-ci", "stale"]);
  const exists = async (name: string) => known.has(name);
  pending.push(
    (async () => {
      // New text points to one real and two missing skills: both are named.
      const missing = await findMissingSkillPointers(
        CURRENT,
        CURRENT +
          "\n- Read skills/dbt-ci first.\n- load_skill('ghost') and skills/phantom.",
        exists,
      );
      assert.deepEqual(missing.sort(), ["ghost", "phantom"]);
      const error = missingSkillPointersError(missing);
      assert.match(error, /'ghost'/);
      assert.match(error, /'phantom'/);
      assert.match(error, /Self-directive unchanged/);

      // A pointer the directive already held is not re-checked: one stale
      // pointer never blocks an unrelated edit.
      const withStale = CURRENT + "\n- → skill 'gone': old note";
      assert.deepEqual(
        await findMissingSkillPointers(
          withStale,
          withStale + "\n- new rule",
          exists,
        ),
        [],
      );
      assert.deepEqual(
        await findMissingSkillPointers(
          CURRENT,
          CURRENT + '\n- load_skill("apps")',
          exists,
        ),
        [],
      );
    })(),
  );
}

// --- adding a line or pointer the directive already holds is skipped -------
{
  const directive = [
    "# Rules",
    "- Amounts are in cents",
    "- → skill 'stripe_quirks': querying Stripe",
  ].join("\n");

  // Same line (bullet and spacing ignored) and same pointer, new wording:
  // both skipped, the new rule kept.
  const r = applySelfDirectiveOperation(directive, {
    operation: "append",
    content: [
      "* Amounts  are in cents",
      "- → skill 'stripe_quirks': Stripe tables",
      "- Dates are UTC",
    ].join("\n"),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value, directive + "\n- Dates are UTC");
    assert.deepEqual(r.skipped, [
      "* Amounts  are in cents",
      "- → skill 'stripe_quirks': Stripe tables",
    ]);
  }

  // Everything already there: the directive is returned unchanged.
  const same = applySelfDirectiveOperation(directive, {
    operation: "prepend",
    content: "- Amounts are in cents",
  });
  assert.deepEqual(same, {
    ok: true,
    value: directive,
    skipped: ["- Amounts are in cents"],
  });

  // insert_after dedupes too.
  const ins = applySelfDirectiveOperation(directive, {
    operation: "insert_after",
    after: "# Rules",
    content: "- Amounts are in cents\n- New first rule",
  });
  assert.equal(ins.ok, true);
  if (ins.ok) assert.match(ins.value, /^# Rules\n- New first rule\n/);

  // A rule line that merely mentions a known skill is not a pointer line:
  // it is kept.
  const rule = dedupeAgainstDirective(
    directive,
    "- Before Stripe joins, load_skill('stripe_quirks')",
  );
  assert.deepEqual(rule.skipped, []);

  // Repeats inside the new content collapse to one line.
  const twice = dedupeAgainstDirective("", "- a\n- a\n- b");
  assert.deepEqual(twice, { content: "- a\n- b", skipped: ["- a"] });

  // The character cap still applies after dedupe.
  const full = applySelfDirectiveOperation(
    "x".repeat(MAX_SELF_DIRECTIVE_LENGTH),
    {
      operation: "append",
      content: "- new",
    },
  );
  assert.equal(full.ok, false);
}

// The tool module now imports skills.service, whose transitive imports hold
// live handles (embedding client, model registration); explicit exit keeps
// the tsx test chain moving.
Promise.all(pending).then(
  () => {
    console.log("self-directive-tool.test.ts passed");
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  },
  error => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  },
);
