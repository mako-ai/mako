/**
 * `aliases` in connector.yaml: read, written by a rename as a line edit,
 * and left out of the content hash.
 */
import { describe, expect, it } from "vitest";
import {
  connectorFileIdentity,
  isValidSlug,
  parseConnectorFile,
  withConnectorAlias,
} from "./connector-file";
import { sourceShaOf } from "./reconcile.service";
import { blobOid } from "../../apps/repository.service";

const aliasesOf = (text: string) => {
  const parsed = parseConnectorFile(text);
  return parsed.ok ? parsed.value.aliases : parsed.reason;
};

describe("connector.yaml aliases", () => {
  it("parses a list of slugs, deduped; anything else is a refusal that names the fix", () => {
    expect(aliasesOf("runtime: node\n")).toEqual([]);
    expect(aliasesOf("runtime: node\naliases: [acme, old, acme]\n")).toEqual([
      "acme",
      "old",
    ]);
    for (const bad of ["acme", "[Acme]", "[1]", "[../x]", "{a: b}", "[true]"]) {
      expect(aliasesOf(`runtime: node\naliases: ${bad}\n`)).toMatch(
        /`aliases` must be a list of previous folder slugs/,
      );
    }
  });

  it("the slug rule is the shared one: lowercase, starts with a letter, at most 64", () => {
    expect(["acme", "a", "acme-crm-2", "a".repeat(64)].every(isValidSlug)).toBe(
      true,
    );
    expect(
      ["", "Acme", "2026", "-a", "a_b", "a/b", "é", "a".repeat(65)].some(
        isValidSlug,
      ),
    ).toBe(false);
  });

  it("adds an alias as a line edit: the author's bytes, comments and line endings stay", () => {
    const plain = "# Acme\nruntime: node # only node\nentry: main.ts\n";
    expect(withConnectorAlias(plain, "acme")).toBe(
      `${plain}aliases:\n  - acme\n`,
    );
    expect(withConnectorAlias("runtime: node", "acme")).toBe(
      "runtime: node\naliases:\n  - acme",
    );
    expect(withConnectorAlias("runtime: node\r\n", "acme")).toBe(
      "runtime: node\r\naliases:\r\n  - acme\r\n",
    );
    // An existing list is extended in its own shape, comments kept.
    expect(
      withConnectorAlias("runtime: node\naliases: [a] # old names\n", "b"),
    ).toBe("runtime: node\naliases: [a, b] # old names\n");
    expect(
      withConnectorAlias("aliases:\n  # first\n  - a\nruntime: node\n", "b"),
    ).toBe("aliases:\n  # first\n  - a\n  - b\nruntime: node\n");
    // Already there: nothing to write.
    expect(withConnectorAlias("runtime: node\naliases: [a]\n", "a")).toBe(
      "runtime: node\naliases: [a]\n",
    );
  });

  it("a slug YAML would read as a boolean or null is written as a string", () => {
    let text = "runtime: node\n";
    for (const slug of ["true", "no", "null", "yes", "off", "y"]) {
      text = withConnectorAlias(text, slug) as string;
      expect(aliasesOf(text)).toContain(slug);
    }
    expect(aliasesOf(text)).toEqual(["true", "no", "null", "yes", "off", "y"]);
  });

  it("refuses a file it cannot read back: nothing is ever written blind", () => {
    for (const bad of [
      "runtime: [",
      "runtime: python\n",
      "runtime: node\naliases: &a [x]\n",
      "runtime: node\naliases:\n  nested: true\n",
      "runtime: node\naliases: [x]\naliases: [y]\n",
    ]) {
      expect([bad, withConnectorAlias(bad, "acme")]).toEqual([bad, null]);
    }
  });

  it("the content hash ignores aliases, and removing them gives back the original bytes", () => {
    for (const original of [
      "runtime: node\nentry: connector.ts\n",
      "runtime: node",
      "runtime: node\r\nentry: connector.ts\r\n",
      "# c\nruntime: node\n\n",
    ]) {
      const once = withConnectorAlias(original, "acme") as string;
      const twice = withConnectorAlias(once, "acme-crm") as string;
      expect(connectorFileIdentity(original)).toBe(original);
      expect(connectorFileIdentity(once)).toBe(original);
      expect(connectorFileIdentity(twice)).toBe(original);
    }
    const files = (yaml: string) =>
      new Map<string, Uint8Array>([
        ["connector.yaml", Buffer.from(yaml)],
        ["connector.ts", Buffer.from("export default 1;\n")],
      ]);
    const yaml = "runtime: node\n";
    // A file without aliases hashes exactly as before this existed, so
    // deploying re-indexes nothing.
    expect(sourceShaOf(files(yaml))).toBe(
      blobOid(
        [
          `connector.ts:${blobOid("export default 1;\n")}`,
          `connector.yaml:${blobOid(yaml)}`,
        ].join("\n"),
      ),
    );
    expect(sourceShaOf(files(withConnectorAlias(yaml, "acme") as string))).toBe(
      sourceShaOf(files(yaml)),
    );
    expect(sourceShaOf(files("runtime: node\nentry: other.ts\n"))).not.toBe(
      sourceShaOf(files(yaml)),
    );
  });
});
