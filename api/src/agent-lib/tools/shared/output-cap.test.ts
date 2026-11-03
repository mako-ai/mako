import type { ToolSet, UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  capLine,
  capText,
  capToolOutputValue,
  capToolPartOutputsForModel,
  pageLines,
  withToolOutputBackstop,
} from "./output-cap";

describe("capText", () => {
  it("returns text under the cap unchanged", () => {
    expect(capText("hello", { maxChars: 10, headChars: 4 })).toEqual({
      text: "hello",
      truncated: false,
      omittedChars: 0,
    });
  });

  it("keeps head and tail with a marker naming the cut", () => {
    const text = `${"a".repeat(1000)}${"b".repeat(1000)}`;
    const capped = capText(text, { maxChars: 100, headChars: 30 });
    expect(capped.truncated).toBe(true);
    expect(capped.text.startsWith("a".repeat(30))).toBe(true);
    expect(capped.text.endsWith("b".repeat(70))).toBe(true);
    expect(capped.omittedChars).toBe(1900);
    expect(capped.text).toContain("1,900 chars omitted");
  });

  it("snaps cuts to line boundaries", () => {
    const text = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n");
    const capped = capText(text, { maxChars: 300, headChars: 100 });
    const [head, tail] = capped.text.split(/\n…\[.*\]…\n/);
    expect(head.endsWith("\n")).toBe(true);
    expect(tail.startsWith("row ")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const text = "😀".repeat(500);
    const capped = capText(text, { maxChars: 101, headChars: 51 });
    expect(capped.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(capped.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("capLine", () => {
  it("shortens long lines and says by how much", () => {
    expect(capLine("abcdef", 10)).toBe("abcdef");
    expect(capLine("a".repeat(30), 10)).toBe(`${"a".repeat(10)}… [+20 chars]`);
  });
});

describe("pageLines", () => {
  const file = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n");

  it("returns everything when it fits", () => {
    const page = pageLines(`${file}\n`);
    expect(page.lines).toHaveLength(10);
    expect(page.totalLines).toBe(10);
    expect(page.nextOffset).toBeUndefined();
  });

  it("pages by offset and limit", () => {
    const page = pageLines(file, { offset: 4, limit: 3 });
    expect(page.lines).toEqual(["l4", "l5", "l6"]);
    expect(page).toMatchObject({ startLine: 4, endLine: 6, nextOffset: 7 });
  });

  it("stops at the char budget but always returns one line", () => {
    const wide = Array.from({ length: 5 }, () => "x".repeat(40)).join("\n");
    const page = pageLines(wide, { maxChars: 100, maxLineChars: 1000 });
    expect(page.lines).toHaveLength(2);
    expect(page.nextOffset).toBe(3);

    const one = pageLines("y".repeat(500), { maxChars: 10, maxLineChars: 50 });
    expect(one.lines).toHaveLength(1);
    expect(one.longLinesCut).toBe(1);
  });

  it("handles empty files and offsets past the end", () => {
    expect(pageLines("")).toMatchObject({ lines: [], totalLines: 0 });
    expect(pageLines(file, { offset: 99 })).toMatchObject({
      lines: [],
      startLine: 0,
      totalLines: 10,
    });
  });
});

describe("capToolOutputValue", () => {
  it("returns the same reference under the cap", () => {
    const output = { rows: [1, 2, 3] };
    expect(capToolOutputValue(output, 1000)).toBe(output);
  });

  it("replaces an oversized result with a head+tail preview", () => {
    const output = { log: "z".repeat(5000) };
    const capped = capToolOutputValue(output, 1000) as Record<string, unknown>;
    expect(capped._outputCapped).toBe(true);
    expect(capped.originalChars).toBe(JSON.stringify(output).length);
    expect((capped.preview as string).length).toBeLessThan(1100);
  });

  it("still caps results that carry a tool's own _truncated flag", () => {
    // sql_execute_query marks >100-row results `_truncated: true`; that must
    // not read as "already capped by the backstop".
    const output = { _truncated: true, data: ["r".repeat(5000)] };
    const capped = capToolOutputValue(output, 1000) as Record<string, unknown>;
    expect(capped._outputCapped).toBe(true);
  });

  it("does not re-cap an already capped result", () => {
    const capped = capToolOutputValue({ log: "z".repeat(5000) }, 1000);
    expect(capToolOutputValue(capped, 10)).toBe(capped);
  });
});

describe("withToolOutputBackstop", () => {
  const big = "q".repeat(5000);
  const tools = {
    plain: { execute: async () => ({ log: big }) },
    small: { execute: async () => ({ ok: true }) },
    mapped: {
      execute: async () => ({ log: big }),
      toModelOutput: () => ({ type: "text", value: "x" }),
    },
    client: { description: "runs in the browser" },
  } as unknown as ToolSet;

  it("caps plain tools, leaves mapped and client tools alone", async () => {
    const wrapped = withToolOutputBackstop(tools, 1000) as unknown as Record<
      string,
      { execute?: (i: unknown, o: unknown) => Promise<unknown> }
    >;
    const run = (name: string) => {
      const execute = wrapped[name].execute;
      if (!execute) throw new Error(`${name} has no execute`);
      return execute({}, {});
    };
    const plain = (await run("plain")) as Record<string, unknown>;
    expect(plain._outputCapped).toBe(true);
    expect(await run("small")).toEqual({ ok: true });
    expect(await run("mapped")).toEqual({ log: big });
    expect(wrapped.client).toBe(
      (tools as unknown as Record<string, unknown>).client,
    );
  });
});

describe("capToolPartOutputsForModel", () => {
  const message = (output: unknown): UIMessage =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "done" },
        {
          type: "tool-app_browse",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output,
        },
      ],
    }) as UIMessage;

  it("leaves small outputs and other roles untouched", () => {
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      message({ ok: true }),
    ] as UIMessage[];
    const result = capToolPartOutputsForModel(messages, 1000);
    expect(result.changed).toBe(false);
    expect(result.messages[1]).toBe(messages[1]);
  });

  it("drops replayed screenshot base64", () => {
    const result = capToolPartOutputsForModel(
      [message({ ok: true, screenshotBase64: "A".repeat(100) })],
      1000,
    );
    expect(result.screenshotsDropped).toBe(1);
    const part = result.messages[0].parts[1] as { output: unknown };
    expect(part.output).toEqual({ ok: true, screenshotOmitted: true });
  });

  it("caps oversized outputs deterministically", () => {
    const input = [message({ log: "w".repeat(5000) })];
    const a = capToolPartOutputsForModel(input, 1000);
    const b = capToolPartOutputsForModel(input, 1000);
    expect(a.cappedCount).toBe(1);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });
});
