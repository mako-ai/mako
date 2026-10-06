import { z } from "zod";

/**
 * Creates a validated persist storage adapter that resets store on validation failure
 */
export function createValidatedStorage<T>(
  schema: z.ZodSchema<T>,
  storageName: string,
  _defaultState: T,
) {
  return {
    getItem: (name: string) => {
      try {
        const str = localStorage.getItem(name);
        if (!str) return null;

        const data = JSON.parse(str);

        // Validate the state
        const validationResult = schema.safeParse(data.state);

        if (!validationResult.success) {
          console.warn(
            `Validation failed for ${storageName}. Resetting to default state.`,
            validationResult.error.issues,
          );
          // Clear corrupted data
          localStorage.removeItem(name);
          return null;
        }

        // Return validated data
        return {
          ...data,
          state: validationResult.data,
        };
      } catch (error) {
        console.error(
          `Failed to parse ${storageName} from localStorage:`,
          error,
        );
        localStorage.removeItem(name);
        return null;
      }
    },
    setItem: (name: string, value: any) => {
      try {
        // Validate before saving
        const validationResult = schema.safeParse(value.state);
        if (!validationResult.success) {
          console.error(
            `Validation failed when saving ${storageName}:`,
            validationResult.error.issues,
          );
          return;
        }
        localStorage.setItem(name, JSON.stringify(value));
      } catch (error) {
        console.error(`Failed to save ${storageName} to localStorage:`, error);
      }
    },
    removeItem: (name: string) => {
      localStorage.removeItem(name);
    },
  };
}

interface DroppedListItem {
  field: string;
  key: string;
  id: string;
  issues: z.ZodIssue[];
}

function listItemId(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    for (const key of ["_id", "id", "executionId"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return `#${index}`;
}

/**
 * Leave out of `state[field][key]` every item that fails `lists[field]`,
 * keeping the rest. A field that is not a record of arrays is left as is
 * for the whole-state schema to judge.
 */
export function pruneInvalidListItems(
  state: unknown,
  lists: Record<string, z.ZodTypeAny>,
): { state: unknown; dropped: DroppedListItem[] } {
  if (!state || typeof state !== "object") return { state, dropped: [] };
  const dropped: DroppedListItem[] = [];
  const out: Record<string, unknown> = { ...(state as object) };
  for (const [field, itemSchema] of Object.entries(lists)) {
    const record = out[field];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      continue;
    }
    const pruned: Record<string, unknown> = {};
    for (const [key, items] of Object.entries(record)) {
      if (!Array.isArray(items)) {
        pruned[key] = items;
        continue;
      }
      pruned[key] = items.filter((item, index) => {
        const result = itemSchema.safeParse(item);
        if (result.success) return true;
        dropped.push({
          field,
          key,
          id: listItemId(item, index),
          issues: result.error.issues,
        });
        return false;
      });
    }
    out[field] = pruned;
  }
  return { state: out, dropped };
}

/** Item signatures already reported this session, per storage. */
const reportedDrops = new Set<string>();

function reportDroppedOnce(
  storageName: string,
  action: "saving" | "reading",
  dropped: DroppedListItem[],
): void {
  const fresh = dropped.filter(item => {
    const signature = [
      storageName,
      item.field,
      item.key,
      item.id,
      item.issues.map(issue => `${issue.path.join(".")}:${issue.code}`),
    ].join("|");
    if (reportedDrops.has(signature)) return false;
    reportedDrops.add(signature);
    return true;
  });
  if (fresh.length === 0) return;
  console.warn(
    `${storageName}: ${fresh.length} item(s) failed validation and were left out when ${action}; the rest was kept.`,
    fresh,
  );
}

/**
 * `createValidatedStorage` for a state whose bulk is lists keyed by
 * workspace (`Record<string, Item[]>`). One item that fails its schema is
 * left out of the copy on disk (or of the copy read back) and the rest is
 * kept: refusing the whole state for one item froze the copy on disk at an
 * older list on every save, and reading it back reset the store. A dropped
 * item is reported once per session, not on every save.
 */
export function createListValidatedStorage<T>(
  schema: z.ZodSchema<T>,
  storageName: string,
  lists: Record<string, z.ZodTypeAny>,
) {
  return {
    getItem: (name: string) => {
      try {
        const str = localStorage.getItem(name);
        if (!str) return null;
        const data = JSON.parse(str);
        const pruned = pruneInvalidListItems(data.state, lists);
        reportDroppedOnce(storageName, "reading", pruned.dropped);
        const validationResult = schema.safeParse(pruned.state);
        if (!validationResult.success) {
          console.warn(
            `Validation failed for ${storageName}. Resetting to default state.`,
            validationResult.error.issues,
          );
          localStorage.removeItem(name);
          return null;
        }
        return { ...data, state: validationResult.data };
      } catch (error) {
        console.error(
          `Failed to parse ${storageName} from localStorage:`,
          error,
        );
        localStorage.removeItem(name);
        return null;
      }
    },
    setItem: (name: string, value: any) => {
      try {
        const pruned = pruneInvalidListItems(value.state, lists);
        reportDroppedOnce(storageName, "saving", pruned.dropped);
        const validationResult = schema.safeParse(pruned.state);
        if (!validationResult.success) {
          console.error(
            `Validation failed when saving ${storageName}:`,
            validationResult.error.issues,
          );
          return;
        }
        localStorage.setItem(
          name,
          JSON.stringify({ ...value, state: pruned.state }),
        );
      } catch (error) {
        console.error(`Failed to save ${storageName} to localStorage:`, error);
      }
    },
    removeItem: (name: string) => {
      localStorage.removeItem(name);
    },
  };
}

// Common Zod refinements and transforms
export const dateString = z.string().transform(str => new Date(str));
export const optionalDateString = z
  .string()
  .optional()
  .nullable()
  .transform(str => (str ? new Date(str) : undefined));

// Ensure errors are always strings
export const errorSchema = z
  .union([z.string(), z.record(z.string(), z.any()), z.null()])
  .transform(val => {
    if (typeof val === "string") return val;
    if (val === null) return null;
    if (typeof val === "object") {
      // Try to extract error message from common error object shapes
      if ("message" in val && typeof val.message === "string") {
        return val.message;
      }
      if ("error" in val && typeof val.error === "string") return val.error;
      // Fallback to JSON stringification for unknown objects
      try {
        return JSON.stringify(val);
      } catch {
        return "Unknown error";
      }
    }
    return "Unknown error";
  });
