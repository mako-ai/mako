import assert from "node:assert/strict";

import { readTaskLogs, shapeRun } from "./runs";

// A fake Hatchet log endpoint: pages of `limit`, oldest first, from `since`
// on. `inclusive` says whether a line at exactly `since` comes back again.
function hatchet(
  lines: { createdAt: string; message: string }[],
  inclusive: boolean,
) {
  const calls: string[] = [];
  const page = async (query: URLSearchParams) => {
    calls.push(query.toString());
    const since = query.get("since");
    const limit = Number(query.get("limit"));
    return lines
      .filter(
        l => !since || (inclusive ? l.createdAt >= since : l.createdAt > since),
      )
      .slice(0, limit);
  };
  return { page, calls };
}

// 2,500 lines, three to a microsecond, so page edges fall inside a tie.
const lines = Array.from({ length: 2500 }, (_, i) => ({
  createdAt: `2026-10-20T10:00:00.${String(Math.floor(i / 3)).padStart(6, "0")}Z`,
  message: `line ${i + 1}`,
}));

async function main() {
  for (const inclusive of [true, false]) {
    const { page, calls } = hatchet(lines, inclusive);
    const read = await readTaskLogs(page);
    if (inclusive) {
      // Every line once, in order.
      assert.deepEqual(
        read.map(l => l.message),
        lines.map(l => l.message),
      );
    } else {
      // A strict `since` drops the tie at each page edge; none is repeated.
      const messages = read.map(l => l.message);
      assert.equal(new Set(messages).size, messages.length);
    }
    assert.ok(calls.length >= 3);
  }

  // The cap stops the reading.
  {
    const { page } = hatchet(lines, true);
    assert.equal((await readTaskLogs(page, 1200)).length, 1200);
  }

  // A Hatchet that ignores `since` returns the same page: reading stops.
  {
    const first = lines.slice(0, 1000);
    const read = await readTaskLogs(async () => first);
    assert.equal(read.length, 1000);
  }

  // The screen's view keeps every line and the whole output; an agent's
  // keeps the last 20 lines and 2,000 characters.
  {
    const output = JSON.stringify({ rows: "x".repeat(10_000) });
    const detail = {
      run: {
        metadata: { id: "r" },
        input: { input: { a: 1 }, triggered_by: "manual" },
      },
      tasks: [
        {
          metadata: { id: "t" },
          actionId: "wf:step",
          status: "COMPLETED",
          output,
        },
      ],
    };
    const logs = { t: lines.slice(0, 1000) };
    const full = shapeRun(detail, logs, { full: true }).steps[0];
    assert.equal(full.logs.length, 1000);
    assert.equal(full.output, output);
    assert.equal(full.outputChars, output.length);
    assert.equal(full.logsTruncated, false);
    const short = shapeRun(detail, logs).steps[0];
    assert.equal(short.logs.length, 20);
    assert.equal(short.logs[19], "line 1000");
    assert.ok((short.output ?? "").length < 2100);
    assert.equal(short.outputChars, output.length);
  }

  console.log("runs.test.ts: ok");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
