/**
 * Close record shaping: the one place backfill pages, webhook payloads and
 * CDC records are turned into the columns the schema declares.
 */

/** Lead fields the legacy list endpoint requests and the schema keeps. */
export const CLOSE_LEAD_FIELDS = [
  "id",
  "name",
  "display_name",
  "description",
  "date_created",
  "date_updated",
  "created_by",
  "created_by_name",
  "updated_by",
  "updated_by_name",
  "organization_id",
  "status_id",
  "status_label",
  "source",
  "addresses",
  "url",
  "html_url",
  "contact_ids",
  "contacts",
  "opportunities",
  "tasks",
  "integration_links",
  "custom",
  "primary_email",
  "primary_phone",
] as const;

const LEAD_ALLOWED_NORMALIZED_FIELDS = new Set<string>(CLOSE_LEAD_FIELDS);

/** Entities whose payloads carry Close custom fields that must be flattened. */
const CUSTOM_FIELD_FLATTEN_ENTITIES = new Set([
  "opportunities",
  "contacts",
  "custom_objects",
  "activities:CustomActivity",
]);

function extractLeadContactIds(record: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const addId = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) ids.add(trimmed);
  };
  const addFromValue = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          addId(item);
        } else if (item && typeof item === "object") {
          addId((item as Record<string, unknown>).id);
        }
      }
      return;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        addFromValue(parsed);
      } catch {
        // Keep raw string values if they look like scalar ids.
        addId(value);
      }
    }
  };

  addFromValue(record.contact_ids);
  if (ids.size === 0) {
    addFromValue(record.contacts);
  }

  return Array.from(ids);
}

/**
 * Flatten custom fields into `custom_<cfId>` columns so that webhook
 * payloads (nested `custom` object) and backfill payloads (flat dotted keys
 * via `_fields=custom.cf_xxx`) both land in the schema-declared columns.
 * Mutates `record`.
 */
export function flattenCloseCustomFields(
  record: Record<string, unknown>,
): void {
  // Flat dotted keys from explicit `_fields` selectors: custom.cf_x → custom_cf_x
  for (const rawKey of Object.keys(record)) {
    if (!/^custom\.(?:cf|lcf)_[A-Za-z0-9]+$/.test(rawKey)) continue;
    const flatKey = rawKey.replace(/\./g, "_");
    if (!(flatKey in record)) {
      record[flatKey] = record[rawKey];
    }
    delete record[rawKey];
  }

  // Nested `custom` object (webhook payloads, Search API `custom` blob)
  if (
    record.custom &&
    typeof record.custom === "object" &&
    !Array.isArray(record.custom)
  ) {
    const customObj = record.custom as Record<string, unknown>;
    for (const [cfKey, cfValue] of Object.entries(customObj)) {
      if (!/^(?:cf|lcf)_[A-Za-z0-9]+$/.test(cfKey)) continue;
      const flatKey = `custom_${cfKey}`;
      if (!(flatKey in record)) {
        record[flatKey] = cfValue;
      }
    }
  }
}

export function normalizeCloseLeadRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(record || {})) {
    const key = rawKey.replace(/\./g, "_");
    if (
      LEAD_ALLOWED_NORMALIZED_FIELDS.has(key) ||
      key.startsWith("custom_cf_") ||
      key.startsWith("custom_lcf_")
    ) {
      normalized[key] = value;
    }
  }

  flattenCloseCustomFields(normalized);

  const contactIds = extractLeadContactIds(record);
  if (contactIds.length > 0) {
    normalized.contact_ids = contactIds;
  }

  return normalized;
}

export function normalizeCloseLeadBatch(records: unknown[]): unknown[] {
  return records.map(record =>
    normalizeCloseLeadRecord((record || {}) as Record<string, unknown>),
  );
}

/**
 * A record of `entity` in its stored shape: leads normalized, entities with
 * custom fields flattened (on a copy), everything else untouched. Returns
 * the input itself when nothing applies.
 */
export function normalizeClosePayload(
  entity: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (entity === "leads") return normalizeCloseLeadRecord(payload);
  if (CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)) {
    const copy = { ...payload };
    flattenCloseCustomFields(copy);
    return copy;
  }
  return payload;
}

/** A Search API page in its stored shape (see normalizeClosePayload). */
export function normalizeCloseSearchBatch(
  entity: string,
  data: unknown[],
): unknown[] {
  if (entity === "leads") return normalizeCloseLeadBatch(data);
  if (CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)) {
    return data.map(record =>
      normalizeClosePayload(entity, (record || {}) as Record<string, unknown>),
    );
  }
  return data;
}
