/**
 * Close custom-field lookups, cached per connector instance: the schema
 * (resolveSchema) and the Search API field selection read the same lookup,
 * so every requested `custom.cf_*` selector has a column and every
 * `custom_cf_*` column is requested.
 */
import type { AxiosInstance } from "axios";
import { loggers } from "../../logging";
import type { CloseCustomField } from "./schema";
import { CLOSE_LEAD_FIELDS } from "./records";

const logger = loggers.connector("close");

const ENTITY_TO_CUSTOM_FIELD_OBJECT_TYPE: Record<string, string> = {
  leads: "lead",
  contacts: "contact",
  opportunities: "opportunity",
};

export const CLOSE_CUSTOM_ACTIVITY_OBJECT_TYPE = "activity.custom_activity";
const ACTIVITY_CUSTOM_FIELD_CACHE_KEY = "activity";

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
  private leadFieldSelection?: string;

  /** `api` is read on every call, so a stubbed client is picked up. */
  constructor(private readonly api: () => AxiosInstance) {}

  async forEntity(entity: string): Promise<CloseCustomField[]> {
    if (entity === "activities:CustomActivity") {
      return this.viaList(
        ACTIVITY_CUSTOM_FIELD_CACHE_KEY,
        "/custom_field/activity/",
      );
    }

    if (entity === "custom_objects") {
      return this.viaList("custom_object", "/custom_field/custom_object_type/");
    }

    const objectType = ENTITY_TO_CUSTOM_FIELD_OBJECT_TYPE[entity];
    if (!objectType) return [];

    return this.viaSchema(objectType);
  }

  /**
   * Custom fields the Search API requests as `custom.cf_*` selectors for one
   * object type, or null when the type carries none.
   */
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

  /**
   * Re-read the custom fields from Close, bypassing the cache. Used when a
   * Search request is rejected mid-run: a field deleted in Close after the
   * schema was cached leaves a dangling `custom.cf_*` selector that Close
   * refuses, and the fix is to re-plan with the current schema — not to
   * shrink the batch.
   */
  async refreshForSearch(objectType: string): Promise<CloseCustomField[]> {
    if (objectType === CLOSE_CUSTOM_ACTIVITY_OBJECT_TYPE) {
      this.cache.delete(ACTIVITY_CUSTOM_FIELD_CACHE_KEY);
    } else {
      this.cache.delete(objectType);
    }
    return (await this.forSearch(objectType)) ?? [];
  }

  /**
   * The `_fields` value for the legacy lead list endpoint: the base lead
   * fields plus every lead and shared custom field as `custom.<id>`.
   */
  async leadSelection(): Promise<string> {
    if (this.leadFieldSelection) {
      return this.leadFieldSelection;
    }

    const fields = new Set<string>(CLOSE_LEAD_FIELDS);
    const api = this.api();
    const customFieldEndpoints = [
      "/custom_field/lead/",
      "/custom_field/shared/",
    ];

    for (const endpoint of customFieldEndpoints) {
      try {
        const response = await api.get(endpoint);
        const customFields = Array.isArray(response?.data?.data)
          ? response.data.data
          : [];
        for (const customField of customFields) {
          const customFieldId =
            typeof customField?.id === "string" ? customField.id.trim() : "";
          if (!customFieldId) continue;
          fields.add(`custom.${customFieldId}`);
        }
      } catch (error) {
        logger.warn("Could not fetch custom field selectors for lead query", {
          endpoint,
          error,
        });
      }
    }

    this.leadFieldSelection = Array.from(fields).join(",");
    return this.leadFieldSelection;
  }

  private async viaSchema(objectType: string): Promise<CloseCustomField[]> {
    const cached = this.cache.get(objectType);
    if (cached) return cached;

    // Outside the try: an unconfigured client throws, not "no fields".
    const api = this.api();
    try {
      const response = await api.get(`/custom_field_schema/${objectType}/`);
      const fields: CloseCustomField[] = (response.data?.fields || []).map(
        (f: RawCustomField) => toCustomField(f, objectType),
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
      const response = await api.get(endpoint);
      const fields: CloseCustomField[] = (response.data?.data || []).map(
        (f: RawCustomField) => toCustomField(f, cacheKey),
      );
      this.cache.set(cacheKey, fields);
      return fields;
    } catch {
      return [];
    }
  }
}
