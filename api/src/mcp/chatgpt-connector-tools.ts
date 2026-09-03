/**
 * ChatGPT connector compatibility: top-level `search` and `fetch` tools.
 *
 * ChatGPT only treats an MCP server as a usable connector (chat + deep
 * research, with citations) when it exposes exactly this pair — `search`
 * returns candidate documents for a query, `fetch` returns one document by
 * id — each as a single JSON-encoded text content item. Without them the
 * server is reachable only in ChatGPT's developer mode. Both tools are plain
 * read-only views over content the rest of the MCP surface already exposes
 * (consoles, dashboards, apps, skills), so registering them for every
 * external client adds capability for ChatGPT without widening access.
 *
 * Contract reference: OpenAI "Building MCP servers for ChatGPT and the API"
 * (search → { results: [{ id, title, text, url }] }; fetch → { id, title,
 * text, url, metadata }).
 */
import { tool } from "ai";
import { Types } from "mongoose";
import { z } from "zod";

import { searchConsoles } from "../agent-lib/tools/console-search-tools";
import { searchDashboardsByQuery } from "../agent-lib/tools/dashboard-search-tools";
import {
  getSystemSkillIndex,
  getSystemSkillFullText,
} from "../agent-lib/skills/system-skills";
import {
  AppProject,
  Dashboard,
  SavedConsole,
  Skill,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  listTree,
  repoDirFor,
  repoExists,
} from "../apps/repository.service";
import { searchSkills } from "../services/skills.service";
import { listAppFolders } from "../apps/worktree.service";
import { loggers } from "../logging";
import type { BridgeableTool, MakoMcpContext } from "./mako-mcp-server";

const logger = loggers.api("mcp-chatgpt");

/** Per-kind cap keeps one search exchange bounded (4 kinds × 5 = ≤20 results). */
const RESULTS_PER_KIND = 5;

/** fetch() text ceiling — ChatGPT ingests the document into model context. */
const MAX_DOCUMENT_CHARS = 60_000;

interface SearchResultDoc {
  id: string;
  title: string;
  text: string;
  url: string | null;
}

interface FetchedDoc extends SearchResultDoc {
  metadata: Record<string, unknown>;
}

function clientBaseUrl(): string {
  return (
    process.env.CLIENT_URL?.replace(/\/$/, "") ||
    process.env.PUBLIC_URL?.replace(/\/$/, "") ||
    "http://localhost:5173"
  );
}

/** Workspace deep links (same prefixes the app's Copy-link share uses). */
function resourceUrl(
  kind: "console" | "dashboard" | "app",
  id: string,
): string {
  const prefix = { console: "c", dashboard: "d", app: "a" }[kind];
  return `${clientBaseUrl()}/${prefix}/${id}`;
}

function truncate(text: string, max = MAX_DOCUMENT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n… [truncated]";
}

function requireObjectId(kind: string, id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error(`Invalid ${kind} id: ${id}`);
  }
  return new Types.ObjectId(id);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

async function searchWorkspaceApps(
  workspaceId: string,
  query: string,
): Promise<SearchResultDoc[]> {
  const folders = await listAppFolders(workspaceId);
  const q = query.trim().toLowerCase();
  return folders
    .filter(
      f =>
        !q ||
        f.slug.toLowerCase().includes(q) ||
        f.title.toLowerCase().includes(q) ||
        (f.description ?? "").toLowerCase().includes(q),
    )
    .slice(0, RESULTS_PER_KIND)
    .map(f => ({
      id: `app:${f.slug}`,
      title: `App: ${f.title}`,
      text: f.description || "Mako data app.",
      url: resourceUrl("app", f.slug),
    }));
}

async function searchAllSkills(
  workspaceId: string,
  query: string,
): Promise<SearchResultDoc[]> {
  const results: SearchResultDoc[] = [];
  const hits = await searchSkills(workspaceId, query, RESULTS_PER_KIND);
  for (const hit of hits) {
    results.push({
      id: `skill:${hit.name}`,
      title: `Skill: ${hit.name}`,
      text: hit.loadWhen || hit.body.slice(0, 300),
      url: null,
    });
  }
  const lowered = query.toLowerCase();
  for (const skill of getSystemSkillIndex()) {
    if (results.length >= RESULTS_PER_KIND) break;
    if (results.some(r => r.id === `skill:${skill.name}`)) continue;
    if (
      skill.name.toLowerCase().includes(lowered) ||
      skill.description.toLowerCase().includes(lowered)
    ) {
      results.push({
        id: `skill:${skill.name}`,
        title: `Skill: ${skill.name}`,
        text: skill.description,
        url: null,
      });
    }
  }
  return results;
}

async function executeSearch(
  workspaceId: string,
  query: string,
): Promise<{ results: SearchResultDoc[] }> {
  const [consoles, dashboards, apps, skills] = await Promise.allSettled([
    searchConsoles(query, workspaceId, RESULTS_PER_KIND),
    searchDashboardsByQuery(query, workspaceId, RESULTS_PER_KIND),
    searchWorkspaceApps(workspaceId, query),
    searchAllSkills(workspaceId, query),
  ]);

  const results: SearchResultDoc[] = [];
  if (consoles.status === "fulfilled") {
    for (const c of consoles.value) {
      results.push({
        id: `console:${c.id}`,
        title: `Console: ${c.title}`,
        text:
          c.description ||
          `Saved ${c.language} console` +
            (c.connectionName ? ` on ${c.connectionName}` : "") +
            ".",
        url: resourceUrl("console", c.id),
      });
    }
  }
  if (dashboards.status === "fulfilled") {
    for (const d of dashboards.value) {
      results.push({
        id: `dashboard:${d.id}`,
        title: `Dashboard: ${d.title}`,
        text:
          d.description ||
          `Dashboard with ${d.widgetCount} widget(s)` +
            (d.dataSourceNames.length
              ? ` over ${d.dataSourceNames.join(", ")}`
              : "") +
            ".",
        url: resourceUrl("dashboard", d.id),
      });
    }
  }
  if (apps.status === "fulfilled") results.push(...apps.value);
  if (skills.status === "fulfilled") results.push(...skills.value);

  for (const outcome of [consoles, dashboards, apps, skills]) {
    if (outcome.status === "rejected") {
      logger.warn("ChatGPT connector search leg failed", {
        workspaceId,
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      });
    }
  }

  return { results };
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

async function fetchConsoleDoc(
  workspaceId: string,
  id: string,
): Promise<FetchedDoc | null> {
  const console_ = await SavedConsole.findOne({
    _id: requireObjectId("console", id),
    workspaceId: new Types.ObjectId(workspaceId),
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  })
    .select("name description code language databaseName")
    .lean();
  if (!console_) return null;
  const text = [
    console_.description || "",
    `Language: ${console_.language}` +
      (console_.databaseName ? ` · Database: ${console_.databaseName}` : ""),
    "```",
    console_.code,
    "```",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: `console:${id}`,
    title: console_.name,
    text: truncate(text),
    url: resourceUrl("console", id),
    metadata: { kind: "console", language: console_.language },
  };
}

async function fetchDashboardDoc(
  workspaceId: string,
  id: string,
): Promise<FetchedDoc | null> {
  const dashboard = await Dashboard.findOne({
    _id: requireObjectId("dashboard", id),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("title description widgets dataSources")
    .lean();
  if (!dashboard) return null;
  const widgets = (
    (dashboard.widgets ?? []) as Array<{ title?: string; type?: string }>
  ).map(w => `- ${w.title || "Untitled"}${w.type ? ` (${w.type})` : ""}`);
  const dataSources = (dashboard.dataSources ?? []).map(ds =>
    [
      `### ${ds.name || "Unnamed source"}`,
      ds.query?.code ? `\`\`\`\n${ds.query.code}\n\`\`\`` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const text = [
    dashboard.description || "",
    widgets.length ? `## Widgets\n${widgets.join("\n")}` : "",
    dataSources.length ? `## Data sources\n${dataSources.join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: `dashboard:${id}`,
    title: dashboard.title || "Untitled dashboard",
    text: truncate(text || "Empty dashboard."),
    url: resourceUrl("dashboard", id),
    metadata: {
      kind: "dashboard",
      widgetCount: dashboard.widgets?.length ?? 0,
    },
  };
}

async function fetchAppDoc(
  workspaceId: string,
  id: string,
): Promise<FetchedDoc | null> {
  const folders = await listAppFolders(workspaceId);
  const folder =
    folders.find(f => f.slug === id) ??
    folders.find(f => `app:${f.slug}` === `app:${id}`);
  if (!folder) {
    // Legacy fetch ids were Mongo ObjectIds.
    if (Types.ObjectId.isValid(id)) {
      const app = await AppProject.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .select("slug")
        .lean();
      if (app?.slug) {
        return fetchAppDoc(workspaceId, app.slug);
      }
    }
    return null;
  }
  const app = await AppProject.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    slug: folder.slug,
  })
    .select("defaultBranch publishedSha")
    .lean();
  let files: string[] = [];
  try {
    const repoDir = repoDirFor(workspaceId);
    if (await repoExists(repoDir)) {
      const prefix = `apps/${folder.slug}/`;
      files = (await listTree(repoDir, app?.defaultBranch || DEFAULT_BRANCH))
        .filter(entry => entry.path.startsWith(prefix))
        .map(entry => `- ${entry.path.slice(prefix.length)}`);
    }
  } catch {
    // Repo unreadable — metadata alone is still a useful doc.
  }
  const text = [
    folder.description || "",
    `Git-backed app project (folder apps/${folder.slug} on branch ${app?.defaultBranch || DEFAULT_BRANCH}).`,
    app?.publishedSha
      ? `Published at commit ${app.publishedSha}.`
      : "Not published yet.",
    files.length ? `## Files\n${files.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: `app:${folder.slug}`,
    title: `App: ${folder.title}`,
    text,
    url: resourceUrl("app", folder.slug),
    metadata: { kind: "app", slug: folder.slug },
  };
}

async function fetchSkillDoc(
  workspaceId: string,
  name: string,
): Promise<FetchedDoc | null> {
  const workspaceSkill = await Skill.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    name,
  })
    .select("name loadWhen body")
    .lean();
  if (workspaceSkill) {
    return {
      id: `skill:${name}`,
      title: workspaceSkill.name,
      text: truncate(
        [
          workspaceSkill.loadWhen ? `When: ${workspaceSkill.loadWhen}` : "",
          workspaceSkill.body,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      url: null,
      metadata: { kind: "skill", scope: "workspace" },
    };
  }
  const systemText = getSystemSkillFullText(name);
  if (!systemText) return null;
  return {
    id: `skill:${name}`,
    title: name,
    text: truncate(systemText),
    url: null,
    metadata: { kind: "skill", scope: "system" },
  };
}

async function executeFetch(
  workspaceId: string,
  id: string,
): Promise<FetchedDoc> {
  const separator = id.indexOf(":");
  const kind = separator === -1 ? "" : id.slice(0, separator);
  const rest = separator === -1 ? "" : id.slice(separator + 1);
  if (!kind || !rest) {
    throw new Error(
      `Invalid document id "${id}". Expected "<kind>:<id>" where kind is ` +
        "console, dashboard, app, or skill — use ids returned by search.",
    );
  }
  let doc: FetchedDoc | null;
  switch (kind) {
    case "console":
      doc = await fetchConsoleDoc(workspaceId, rest);
      break;
    case "dashboard":
      doc = await fetchDashboardDoc(workspaceId, rest);
      break;
    case "app":
      doc = await fetchAppDoc(workspaceId, rest);
      break;
    case "skill":
      doc = await fetchSkillDoc(workspaceId, rest);
      break;
    default:
      throw new Error(
        `Unknown document kind "${kind}". Supported: console, dashboard, app, skill.`,
      );
  }
  if (!doc) {
    throw new Error(`Document not found in this workspace: ${id}`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

/**
 * The `search` / `fetch` pair ChatGPT requires. Registered for every external
 * (non-ACP) MCP client — other clients simply gain a compact workspace
 * search; Desktop ACP omits them (it has richer in-product search).
 */
export function createChatGptConnectorTools(
  context: MakoMcpContext,
): Record<string, BridgeableTool> {
  const { workspaceId } = context;
  return {
    search: tool({
      description:
        "Search this Mako workspace for saved consoles (queries), " +
        "dashboards, apps, and skills matching a query. Returns a list of " +
        "documents with ids to pass to fetch. Searches workspace content " +
        "only — use sql_execute_query to query the connected databases " +
        "themselves.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Free-text search query (e.g. 'monthly revenue')."),
      }),
      execute: async ({ query }) => executeSearch(workspaceId, query),
    }),
    fetch: tool({
      description:
        "Retrieve the full content of one workspace document found via " +
        "search: a saved console (including its SQL), dashboard (widgets + " +
        "data source queries), app (files + data bindings), or skill.",
      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .describe(
            'Document id from search results, e.g. "console:64ac…" or "skill:apps".',
          ),
      }),
      execute: async ({ id }) => executeFetch(workspaceId, id),
    }),
  };
}
