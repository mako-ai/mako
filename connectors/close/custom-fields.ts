/**
 * Close custom-field lookups, cached per process. A box process serves one
 * chunk, as a fresh in-process connector instance does per chunk, so the
 * cache lifetime matches (port of `api/src/connectors/close/custom-fields.ts`).
 */
import type { CloseClient } from "./client.ts";
import type { CloseCustomField } from "./schema.ts";

const ENTITY_TO_SCHEMA_OBJECT_TYPE: Record<string, string> = {
  leads: "lead",
  contacts: "contact",
  opportunities: "opportunity",
};

export const CLOSE_CUSTOM_ACTIVITY_OBJECT_TYPE = "activity.custom_activity";
const ACTIVITY_CACHE_KEY = "activity";

type RawCustomField = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  accepts_multiple_values?: unknown;
};

function toCustomField(f: RawCustomField, appliesTo: string): CloseCustomField {
  return {
    id: String(f.id || ""),
    name: String(f.name || ""),
    type: String(f.type || "text"),
    appliesTo,
    acceptsMultipleValues: Boolean(f.accepts_multiple_values),
  };
}

export class CloseCustomFieldCache {
  private readonly cache = new Map<string, CloseCustomField[]>();
  private readonly api: () => CloseClient;
  /** `api` is read on every call. */
  constructor(api: () => CloseClient) {
    this.api = api;
  }

  async forEntity(entity: string): Promise<CloseCustomField[]> {
    if (entity === "activities:CustomActivity") {
      return this.viaList(ACTIVITY_CACHE_KEY, "/custom_field/activity/");
    }
    if (entity === "custom_objects") {
      return this.viaList("custom_object", "/custom_field/custom_object_type/");
    }
    const objectType = ENTITY_TO_SCHEMA_OBJECT_TYPE[entity];
    return objectType ? this.viaSchema(objectType) : [];
  }

  async forSearch(objectType: string): Promise<CloseCustomField[] | null> {
    if (objectType === CLOSE_CUSTOM_ACTIVITY_OBJECT_TYPE) {
      return this.forEntity("activities:CustomActivity");
    }
    if (
      objectType === "lead" ||
      objectType === "contact" ||
      objectType === "opportunity"
    ) {
      return this.viaSchema(objectType);
    }
    return null;
  }

  /** Re-read from Close, bypassing the cache, after a rejected selection. */
  async refreshForSearch(objectType: string): Promise<CloseCustomField[]> {
    this.cache.delete(
      objectType === CLOSE_CUSTOM_ACTIVITY_OBJECT_TYPE
        ? ACTIVITY_CACHE_KEY
        : objectType,
    );
    return (await this.forSearch(objectType)) ?? [];
  }

  private async viaSchema(objectType: string): Promise<CloseCustomField[]> {
    const cached = this.cache.get(objectType);
    if (cached) return cached;
    const api = this.api();
    try {
      const body = await api.get(`/custom_field_schema/${objectType}/`);
      const fields = ((body?.fields || []) as RawCustomField[]).map(f =>
        toCustomField(f, objectType),
      );
      this.cache.set(objectType, fields);
      return fields;
    } catch {
      return [];
    }
  }

  private async viaList(
    cacheKey: string,
    endpoint: string,
  ): Promise<CloseCustomField[]> {
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const api = this.api();
    try {
      const body = await api.get(endpoint);
      const fields = ((body?.data || []) as RawCustomField[]).map(f =>
        toCustomField(f, cacheKey),
      );
      this.cache.set(cacheKey, fields);
      return fields;
    } catch {
      return [];
    }
  }
}
