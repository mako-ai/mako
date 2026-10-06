/**
 * Process versions: a version is the hash of what the code IS — the `run`
 * function's source plus the manifest (tools + effects, triggers, input
 * schema). Each distinct hash is stored once, immutably, with its source text,
 * so "which definition ran" is always answerable, per run and per event.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProcessDefinition } from "../sdk";
import {
  ProcessVersion,
  type OutlineItem,
  type ProcessManifest,
} from "./models";

export interface VersionRef {
  id: string;
  number: number;
  hash: string;
}

export function buildManifest(definition: ProcessDefinition): ProcessManifest {
  return {
    name: definition.name,
    description: definition.description,
    triggers: definition.triggers,
    tools: (definition.tools ?? []).map(tool => ({
      name: tool.name,
      effect: tool.effect,
      description: tool.description,
      connections: [...(tool.connections ?? [])],
    })),
    inputSchema: z.toJSONSchema(definition.input, { unrepresentable: "any" }),
  };
}

/**
 * The readable outline: every primitive call site in `run`, in source order.
 * Derived from code (never authored separately), so it cannot drift. Names
 * built from template literals are marked dynamic (loops, per-item steps).
 */
export function extractOutline(source: string): OutlineItem[] {
  const param =
    /^\s*(?:async\s+)?(?:function\s*[\w$]*\s*|[\w$]+\s*)?\(\s*([A-Za-z_$][\w$]*)/.exec(
      source,
    )?.[1] ??
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source)?.[1] ??
    "ctx";
  const re = new RegExp(
    `\\b${param.replace(/\$/g, "\\$")}\\.(step|agent|approval|task|wait)\\(\\s*(["'\`])((?:\\\\.|(?!\\2)[^\\\\])*)\\2`,
    "g",
  );
  const items: OutlineItem[] = [];
  for (const match of source.matchAll(re)) {
    const quote = match[2];
    const name = match[3];
    items.push({
      kind: match[1] as OutlineItem["kind"],
      // `${item.system}` → {system}: readable, and says what varies.
      name:
        quote === "`"
          ? name.replace(
              /\$\{([^}]*)\}/g,
              (_, expr: string) =>
                `{${
                  expr
                    .split(/[^\w$]+/)
                    .filter(Boolean)
                    .pop() ?? "…"
                }}`,
            )
          : name,
      dynamic: quote === "`" && name.includes("${"),
    });
  }
  return items;
}

export function computeVersionHash(definition: ProcessDefinition): {
  hash: string;
  source: string;
  manifest: ProcessManifest;
} {
  const source = definition.run.toString();
  const manifest = buildManifest(definition);
  const hash = createHash("sha256")
    .update(JSON.stringify({ id: definition.id, source, manifest }))
    .digest("hex")
    .slice(0, 16);
  return { hash, source, manifest };
}

const cache = new Map<string, VersionRef>();

/** The stored version of the code currently loaded. Idempotent; cached. */
export async function ensureVersion(
  definition: ProcessDefinition,
): Promise<VersionRef> {
  const { hash, source, manifest } = computeVersionHash(definition);
  const cacheKey = `${definition.id}:${hash}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await ProcessVersion.findOne({
      processId: definition.id,
      hash,
    })
      .select("_id number hash")
      .lean();
    if (existing) {
      const ref = {
        id: existing._id.toString(),
        number: existing.number,
        hash,
      };
      cache.set(cacheKey, ref);
      return ref;
    }
    const latest = await ProcessVersion.findOne({ processId: definition.id })
      .sort({ number: -1 })
      .select("number")
      .lean();
    try {
      const created = await ProcessVersion.create({
        processId: definition.id,
        hash,
        number: (latest?.number ?? 0) + 1,
        source,
        outline: extractOutline(source),
        manifest,
        firstSeenBuild:
          process.env.GIT_SHA || process.env.K_REVISION || undefined,
      });
      const ref = { id: created._id.toString(), number: created.number, hash };
      cache.set(cacheKey, ref);
      return ref;
    } catch (error) {
      // Lost a race on (processId, hash) or (processId, number): re-read.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  throw new Error(`Could not register a version for process ${definition.id}`);
}

/** Tests only: versions live in a fresh database per suite. */
export function clearVersionCache(): void {
  cache.clear();
}
