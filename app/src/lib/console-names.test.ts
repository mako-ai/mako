import { describe, expect, it } from "vitest";
import {
  consoleNamePreview,
  consolePathPreview,
  nameFieldHint,
  savedAsNotice,
  savedPathWords,
} from "./console-names";

describe("what a console name will be saved as", () => {
  it("gives each character a file name cannot carry a readable stand-in", () => {
    expect(consoleNamePreview("Q1: revenue", "console")).toEqual({
      name: "Q1 - revenue",
      changed: true,
      error: null,
    });
    expect(consoleNamePreview('a/b\\c|d*e?f"g<h>', "console").name).toBe(
      "a-b-c-d-ef'g(h)",
    );
    // NFC and single spaces; the edges are trimmed without a word.
    expect(consoleNamePreview("  Café   au lait ", "console")).toEqual({
      name: "Café au lait",
      changed: true,
      error: null,
    });
    expect(consoleNamePreview("  plain  ", "folder").changed).toBe(false);
  });

  it("refuses what is still no name, with the reason", () => {
    const refused: Array<[string, RegExp]> = [
      ["???", /empty/],
      ["..", /not a name/],
      [".hidden", /start with a dot/],
      ["report.", /end with a dot/],
      ["con", /reserved/],
      ["NUL.txt", /reserved/],
      ["a\tb", /control characters/],
      ["x".repeat(121), /at most 120/],
    ];
    for (const [raw, reason] of refused) {
      expect(consoleNamePreview(raw, "console").error, raw).toMatch(reason);
    }
    expect(consoleNamePreview("x".repeat(120), "console").error).toBeNull();
    expect(
      consoleNamePreview("lib.mongodb", "console", "javascript").error,
    ).toMatch(/MongoDB/);
    expect(consoleNamePreview("lib.mongodb", "folder").error).toBeNull();
  });

  it("the field's hint says “Will be saved as …”, the refusal, or nothing", () => {
    expect(nameFieldHint("", "console")).toBeNull();
    expect(nameFieldHint("report", "console")).toBeNull();
    expect(nameFieldHint("Q1: revenue", "console")).toEqual({
      text: "Will be saved as “Q1 - revenue”",
      error: false,
    });
    expect(nameFieldHint("con", "folder")).toMatchObject({ error: true });
  });

  it("in the Save dialog a path names folders, then the console", () => {
    expect(consolePathPreview("Team/Q1: plans/report?")).toEqual({
      name: "Team/Q1 - plans/report",
      changed: true,
      error: null,
    });
    expect(nameFieldHint("Team/report", "path")?.text).toBe(
      "Will be saved as “report” in the folder “Team”",
    );
    expect(nameFieldHint("report", "path")).toBeNull();
    expect(nameFieldHint("Team/../report", "path")).toMatchObject({
      error: true,
    });
    // A move's name is one name: the slash is a character of it.
    expect(nameFieldHint("Team/report", "console")?.text).toBe(
      "Will be saved as “Team-report”",
    );
  });

  it("says where a slash in the Save dialog files the console, never silently", () => {
    expect(nameFieldHint("A/B test", "path")).toEqual({
      text: "Will be saved as “B test” in the folder “A”",
      error: false,
    });
    expect(nameFieldHint("A/Q1: x/B test", "path")?.text).toBe(
      "Will be saved as “B test” in the folder “A/Q1 - x”",
    );
    // With a folder picked in the dialog, that is where it goes.
    expect(
      nameFieldHint("A/B test", "path", { inSelectedFolder: true })?.text,
    ).toBe(
      "Will be saved as “B test” in the selected folder (“A/” is not used)",
    );
    expect(savedPathWords("B test")).toBe("“B test”");
    expect(savedPathWords("A/B test")).toBe("“B test” in the folder “A”");
  });

  it("after the fact, says the name only when it is not what was typed", () => {
    expect(savedAsNotice("a:b", "a - b")).toBe("Saved as “a - b”");
    expect(savedAsNotice(" report ", "report")).toBeNull();
  });
});
