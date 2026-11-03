/**
 * Semantic app search, offline: the blend of word matches and related apps
 * (fixed fake vectors, no network), the related bar, and the document an
 * app is embedded as (built from a real git repo).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RELATED_MATCH,
  RELATED_MAX,
  RELATED_MIN_SIMILARITY,
  RELATED_SMALL_WORKSPACE_SIMILARITY,
  rankApps,
  relatedThreshold,
  type SearchableApp,
} from "./app-search";
import {
  EMBEDDING_DOC_MAX_CHARS,
  buildAppEmbeddingDocument,
  documentTerms,
  embeddingDocHash,
  tableWords,
  uiStrings,
} from "./app-embedding-doc";
import { dot, readAppEmbeddingDocs } from "./app-embeddings.service";

/** A unit vector at `angle` radians from the query axis, in 2-D. */
function at(cos: number): Float32Array {
  return new Float32Array([cos, Math.sqrt(1 - cos * cos)]);
}
const QUERY = new Float32Array([1, 0]);

function app(id: string, title: string, extra: Partial<SearchableApp> = {}) {
  return { appId: id, path: `apps/${id}`, title, tables: [], ...extra };
}

/**
 * 30 apps: most sit near cosine 0.15 (the noise floor of a real workspace),
 * a few stand out. The query is "acquisition".
 */
function workspace() {
  const apps: SearchableApp[] = [];
  const cos = new Map<string, number>();
  for (let i = 0; i < 26; i++) {
    const id = `noise${String(i).padStart(2, "0")}`;
    apps.push(app(id, `Report ${i}`));
    cos.set(id, 0.12 + (i % 5) * 0.015);
  }
  apps.push(app("funnel", "Agent Acquisition Funnel"));
  cos.set("funnel", 0.25);
  apps.push(app("onboarding", "Self-Onboarding Launch"));
  cos.set("onboarding", 0.42);
  // Its title says nothing; its UI has an "Acquisition channel" filter.
  apps.push(app("intl", "INTL Sales Dashboard"));
  cos.set("intl", 0.21);
  // Says "acquisition" too, but is less similar than the average app.
  apps.push(app("dump", "Raw dump"));
  cos.set("dump", 0.05);
  const similarity = new Map(
    [...cos].map(([id, c]) => [id, dot(QUERY, at(c))]),
  );
  const terms = new Map<string, string[]>([
    ["intl", ["sales", "acquisition", "channel", "outbound"]],
    ["dump", ["acquisition"]],
    ["funnel", ["agent", "acquisition", "funnel"]],
  ]);
  return { apps, similarity, terms };
}

describe("related apps blend", () => {
  it("keeps word matches first, then related apps, closest first", () => {
    const { apps, similarity, terms } = workspace();
    const hits = rankApps(apps, "acquisition", {
      limit: 50,
      related: { similarity, terms },
    });
    expect(hits.map(h => h.appId)).toEqual(["funnel", "onboarding", "intl"]);
    expect(hits[0].matchedOn).toContain("title");
    expect(hits[1].matchedOn).toEqual([RELATED_MATCH]);
    // A related hit's score is its similarity: never above a word match.
    expect(hits[1].score).toBeCloseTo(0.42, 2);
    expect(hits[2].matchedOn).toEqual([RELATED_MATCH]);
  });

  it("finds an app whose document holds the words, not one below average", () => {
    const { apps, similarity, terms } = workspace();
    const ids = rankApps(apps, "acquisition", {
      limit: 50,
      related: { similarity, terms },
    }).map(h => h.appId);
    expect(ids).toContain("intl");
    expect(ids).not.toContain("dump");
    // Without the words, 0.21 is under the bar: semantic alone misses it.
    const semanticOnly = rankApps(apps, "acquisition", {
      limit: 50,
      related: { similarity },
    }).map(h => h.appId);
    expect(semanticOnly).not.toContain("intl");
  });

  it("is the lexical ranking when there are no signals", () => {
    const { apps } = workspace();
    const lexical = rankApps(apps, "acquisition", { limit: 50 });
    expect(lexical.map(h => h.appId)).toEqual(["funnel"]);
    expect(
      rankApps(apps, "acquisition", {
        limit: 50,
        related: { similarity: new Map() },
      }),
    ).toEqual(lexical);
    expect(rankApps(apps, "acquisition", { related: null })).toEqual(lexical);
  });

  it("returns only the apps it was given (visibility is the caller's)", () => {
    const { apps, similarity, terms } = workspace();
    const visible = apps.filter(a => a.appId !== "onboarding");
    const ids = rankApps(visible, "acquisition", {
      limit: 50,
      related: { similarity, terms },
    }).map(h => h.appId);
    expect(ids).not.toContain("onboarding");
  });

  it("caps related apps and respects the overall limit", () => {
    const apps: SearchableApp[] = [];
    const similarity = new Map<string, number>();
    for (let i = 0; i < 115; i++) {
      const id = `a${String(i).padStart(3, "0")}`;
      apps.push(app(id, `Thing ${i}`));
      // 100 at the noise floor, 15 well above the bar.
      similarity.set(id, i < 100 ? 0.1 : 0.6 + i / 1000);
    }
    const hits = rankApps(apps, "something else", {
      limit: 50,
      related: { similarity },
    });
    expect(hits).toHaveLength(RELATED_MAX);
    expect(hits[0].appId).toBe("a114");
    expect(
      rankApps(apps, "something else", { limit: 3, related: { similarity } }),
    ).toHaveLength(3);
  });

  it("breaks exact lexical ties by similarity", () => {
    const apps = [app("x", "Churn"), app("y", "Churn")];
    const similarity = new Map([
      ["x", 0.2],
      ["y", 0.4],
    ]);
    expect(rankApps(apps, "churn").map(h => h.appId)).toEqual(["x", "y"]);
    expect(
      rankApps(apps, "churn", { related: { similarity } }).map(h => h.appId),
    ).toEqual(["y", "x"]);
  });

  it("sets the bar relative to the query's spread, with a floor", () => {
    // Everything compressed and low: the floor holds ("zebra").
    expect(relatedThreshold(Array(50).fill(0.14))).toBe(RELATED_MIN_SIMILARITY);
    // Everything high ("investor deck"): the bar rises above the crowd.
    const high = Array.from({ length: 50 }, (_, i) => 0.25 + (i % 10) * 0.015);
    expect(relatedThreshold(high)).toBeGreaterThan(0.36);
    // Too few apps for a spread: an absolute bar.
    expect(relatedThreshold([0.1, 0.2, 0.3])).toBe(
      RELATED_SMALL_WORKSPACE_SIMILARITY,
    );
  });
});

describe("the embedding document", () => {
  const sources = [
    {
      path: "src/App.tsx",
      text: `
        export default function App() {
          return (
            <div className="flex items-center gap-2 text-sm">
              <h1>INTL Sales Dashboard</h1>
              <Picker label="Acquisition channel" value={url.channel} />
              <Tabs items={[{ label: "Overview" }, { label: "Cohorts" }]} />
              {loading ? <Spinner /> : null}
              <TextField placeholder="Search rows" />
              <span className="text-muted-foreground">{value}</span>
            </div>
          );
        }`,
    },
  ];

  it("keeps what a person reads in the UI, drops code", () => {
    const strings = uiStrings(sources, 1000);
    expect(strings).toEqual(
      expect.arrayContaining([
        "INTL Sales Dashboard",
        "Acquisition channel",
        "Overview",
        "Cohorts",
        "Search rows",
      ]),
    );
    expect(strings.join(" ")).not.toMatch(/flex|items-center|text-muted/);
  });

  it("names tables by their words, without project, schema or dbt layer", () => {
    expect(
      tableWords([
        "realadvisor-prod.{{dbt_schema}}.fct_intl_sales_demos",
        "{{dbt_schema}}.dim_account",
        "realadvisor-prod.talent.__tables__",
        "close.leads",
      ]),
    ).toEqual(["intl sales demos", "account", "leads"]);
  });

  it("is bounded, deterministic, and hashed with its model", () => {
    const input = {
      title: "INTL Sales Dashboard",
      description: "Sales by country",
      path: "apps/Sales/intl-sales-dashboard",
      tables: ["close.leads"],
      readme: `# Notes\n\n${"A long changelog line. ".repeat(500)}`,
      sources,
    };
    const doc = buildAppEmbeddingDocument(input);
    expect(doc.length).toBeLessThanOrEqual(EMBEDDING_DOC_MAX_CHARS);
    expect(doc).toContain("Folder: Sales / intl sales dashboard");
    expect(doc).toContain("Acquisition channel");
    expect(doc.indexOf("UI:")).toBeLessThan(doc.indexOf("changelog"));
    expect(buildAppEmbeddingDocument(input)).toBe(doc);
    expect(embeddingDocHash(doc, "m1")).toBe(embeddingDocHash(doc, "m1"));
    expect(embeddingDocHash(doc, "m1")).not.toBe(embeddingDocHash(doc, "m2"));
    expect(documentTerms(doc)).toContain("acquisition");
  });

  const dir = mkdtempSync(path.join(tmpdir(), "app-embedding-doc-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads README and UI sources from git at a commit", async () => {
    const appDir = path.join(dir, "apps", "sales");
    mkdirSync(path.join(appDir, "src", "components"), { recursive: true });
    writeFileSync(
      path.join(appDir, "README.md"),
      "# Sales\n\nPipeline by stage.",
    );
    writeFileSync(path.join(appDir, "src", "App.tsx"), sources[0].text);
    writeFileSync(
      path.join(appDir, "src", "components", "Kpi.tsx"),
      `<Card title="Won deals" />`,
    );
    writeFileSync(
      path.join(appDir, "src", "App.test.tsx"),
      `<h1>Should not count</h1>`,
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "init",
    );
    const sha = git("rev-parse", "HEAD");
    const docs = await readAppEmbeddingDocs(dir, sha, [
      { path: "apps/sales", title: "Sales", tables: [] },
    ]);
    const doc = docs.get("apps/sales") ?? "";
    expect(doc).toContain("Pipeline by stage.");
    expect(doc).toContain("Acquisition channel");
    expect(doc).toContain("Won deals");
    expect(doc).not.toContain("Should not count");
  });
});
