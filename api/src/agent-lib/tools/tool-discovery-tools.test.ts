/**
 * Unit tests for search_tools / load_tools response notes — these notes are
 * what stop the model from looping on already-loaded deferred tools.
 */
import assert from "node:assert/strict";
import {
  buildLoadToolsNote,
  buildSearchToolsNote,
  createToolDiscoveryTools,
} from "./tool-discovery-tools";
import type { ModeState } from "../../agents/modes/types";
import type { ToolCatalogEntry } from "../tool-catalog";

{
  assert.match(
    buildSearchToolsNote({ hitCount: 0, unloadedCount: 0, loadedCount: 0 }),
    /No matching tools/,
  );
  assert.match(
    buildSearchToolsNote({ hitCount: 1, unloadedCount: 0, loadedCount: 1 }),
    /already active/,
  );
  assert.match(
    buildSearchToolsNote({ hitCount: 1, unloadedCount: 0, loadedCount: 1 }),
    /Do NOT call load_tools/,
  );
  assert.match(
    buildSearchToolsNote({ hitCount: 2, unloadedCount: 2, loadedCount: 0 }),
    /Call load_tools/,
  );
  assert.match(
    buildSearchToolsNote({ hitCount: 2, unloadedCount: 1, loadedCount: 1 }),
    /already active/,
  );
}

{
  assert.match(
    buildLoadToolsNote({
      loadedNow: ["save_skill"],
      alreadyActive: [],
      unknown: [],
    }) ?? "",
    /Loaded\. Call these tools directly/,
  );
  assert.match(
    buildLoadToolsNote({
      loadedNow: [],
      alreadyActive: ["save_skill"],
      unknown: [],
    }) ?? "",
    /Already active/,
  );
  assert.match(
    buildLoadToolsNote({
      loadedNow: [],
      alreadyActive: ["save_skill"],
      unknown: [],
    }) ?? "",
    /Do NOT call load_tools/,
  );
  assert.equal(
    buildLoadToolsNote({
      loadedNow: [],
      alreadyActive: [],
      unknown: ["nope"],
    }),
    undefined,
  );
}

async function endToEnd() {
  const catalog: ToolCatalogEntry[] = [
    {
      name: "save_skill",
      description: "Save or overwrite a workspace-scoped skill",
      tier: "deferred",
      source: { kind: "builtin", domain: "skills" },
      readOnly: false,
    },
    {
      name: "delete_skill",
      description: "Delete a workspace skill by name",
      tier: "deferred",
      source: { kind: "builtin", domain: "skills" },
      readOnly: false,
    },
  ];

  const modeState: ModeState = {
    enabledModes: new Set(["query"]),
    planSubmitted: false,
    planApproved: false,
    approvedCapabilityGrants: new Set(),
    loadedToolNames: ["save_skill"],
  };

  const tools = createToolDiscoveryTools({ modeState, catalog });

  const search = tools.search_tools as {
    execute: (input: { query: string }) => Promise<{
      results: Array<{ name: string; loaded: boolean }>;
      note: string;
    }>;
  };
  const searchResult = await search.execute({
    query: "save or overwrite a workspace-scoped skill",
  });
  const saveHit = searchResult.results.find(r => r.name === "save_skill");
  assert.ok(saveHit, "search returns save_skill");
  assert.equal(saveHit.loaded, true);
  // Either all hits are loaded, or mixed — both notes must push the model
  // toward calling the tool, not re-searching endlessly.
  assert.match(searchResult.note, /already active|Call load_tools/);
  assert.doesNotMatch(searchResult.note, /never guess/i);

  const load = tools.load_tools as {
    execute: (input: { names: string[] }) => Promise<{
      loaded: string[];
      alreadyLoaded: string[];
      note?: string;
    }>;
  };
  const loadResult = await load.execute({ names: ["save_skill"] });
  assert.deepEqual(loadResult.loaded, []);
  assert.deepEqual(loadResult.alreadyLoaded, ["save_skill"]);
  assert.match(loadResult.note ?? "", /Already active/);
  assert.match(loadResult.note ?? "", /Do NOT call load_tools/);

  // Pure already-loaded search note (single deferred entry).
  const singleCatalog = catalog.filter(e => e.name === "save_skill");
  const singleTools = createToolDiscoveryTools({
    modeState,
    catalog: singleCatalog,
  });
  const singleSearch = singleTools.search_tools as typeof search;
  const singleResult = await singleSearch.execute({ query: "save_skill" });
  assert.equal(singleResult.results.length, 1);
  assert.equal(singleResult.results[0]?.loaded, true);
  assert.match(singleResult.note, /already active/);
  assert.match(singleResult.note, /Do NOT call load_tools/);

  // eslint-disable-next-line no-console
  console.log("tool-discovery-tools.test.ts: all assertions passed");
}

void endToEnd()
  .then(() => {
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
