/**
 * Close's Search never returns a lead's `source`, even when `_fields` names
 * it. It returns the smart field `first_source` with the same value. Both
 * Close connectors, in-process and the folder (`connectors/close/`), request
 * `first_source` and store it as `source`. An explicit `source` (a webhook
 * payload) wins.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FOLDER } from "../../../../connectors/close/fixtures/harness.mjs";
import { closeSearchBaseFields } from "./entities";
import { normalizeCloseLeadRecord as inProcessNormalize } from "./records";

type Row = Record<string, unknown>;

let folderNormalize: (record: Row) => Row;
let folderLeadFields: string[];

before(async () => {
  const load = (file: string) =>
    import(pathToFileURL(path.join(FOLDER, file)).href);
  folderNormalize = (await load("records.ts")).normalizeCloseLeadRecord;
  folderLeadFields = (await load("catalog.ts")).CLOSE_SEARCH_BASE_FIELDS.lead;
});

const connectors = () => [
  { name: "in-process", normalize: inProcessNormalize },
  { name: "folder", normalize: folderNormalize },
];

void test("both connectors request first_source on lead Search", () => {
  assert.ok(closeSearchBaseFields().lead.includes("first_source"));
  assert.ok(folderLeadFields.includes("first_source"));
});

void test("a Search lead with first_source and no source stores source", () => {
  for (const { name, normalize } of connectors()) {
    const row = normalize({ id: "lead_1", first_source: "api" });
    assert.equal(row.source, "api", name);
    assert.ok(!("first_source" in row), name);
  }
});

void test("an explicit source wins over first_source", () => {
  for (const { name, normalize } of connectors()) {
    const row = normalize({
      id: "lead_1",
      source: "ui",
      first_source: "api",
    });
    assert.equal(row.source, "ui", name);
    assert.ok(!("first_source" in row), name);
  }
});

void test("a null source stays null", () => {
  for (const { name, normalize } of connectors()) {
    const row = normalize({ id: "lead_1", source: null, first_source: "api" });
    assert.equal(row.source, null, name);
  }
});

void test("a lead without either field gets no source", () => {
  for (const { name, normalize } of connectors()) {
    assert.ok(!("source" in normalize({ id: "lead_1" })), name);
  }
});
