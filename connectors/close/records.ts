/**
 * Close record shaping, a port of `api/src/connectors/close/records.ts`:
 * leads keep their declared fields, and entities with custom fields get them
 * flattened into `custom_<cfId>` columns.
 */

type Row = Record<string, unknown>;

/** Lead fields the schema keeps. */
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

const LEAD_ALLOWED_FIELDS = new Set<string>(CLOSE_LEAD_FIELDS);

const CUSTOM_FIELD_FLATTEN_ENTITIES = new Set([
  "opportunities",
  "contacts",
  "custom_objects",
  "activities:CustomActivity",
]);

function extractLeadContactIds(record: Row): string[] {
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
        if (typeof item === "string") addId(item);
        else if (item && typeof item === "object") addId((item as Row).id);
      }
      return;
    }
    if (typeof value === "string") {
      try {
        addFromValue(JSON.parse(value));
      } catch {
        addId(value);
      }
    }
  };
  addFromValue(record.contact_ids);
  if (ids.size === 0) addFromValue(record.contacts);
  return Array.from(ids);
}

/** `custom.cf_x` and `custom: { cf_x }` both become `custom_cf_x`. Mutates. */
export function flattenCloseCustomFields(record: Row): void {
  for (const rawKey of Object.keys(record)) {
    if (!/^custom\.(?:cf|lcf)_[A-Za-z0-9]+$/.test(rawKey)) continue;
    const flatKey = rawKey.replace(/\./g, "_");
    if (!(flatKey in record)) record[flatKey] = record[rawKey];
    delete record[rawKey];
  }
  if (
    record.custom &&
    typeof record.custom === "object" &&
    !Array.isArray(record.custom)
  ) {
    for (const [cfKey, cfValue] of Object.entries(record.custom as Row)) {
      if (!/^(?:cf|lcf)_[A-Za-z0-9]+$/.test(cfKey)) continue;
      const flatKey = `custom_${cfKey}`;
      if (!(flatKey in record)) record[flatKey] = cfValue;
    }
  }
}

export function normalizeCloseLeadRecord(record: Row): Row {
  const normalized: Row = {};
  for (const [rawKey, value] of Object.entries(record || {})) {
    const key = rawKey.replace(/\./g, "_");
    if (
      LEAD_ALLOWED_FIELDS.has(key) ||
      key.startsWith("custom_cf_") ||
      key.startsWith("custom_lcf_")
    ) {
      normalized[key] = value;
    }
  }
  flattenCloseCustomFields(normalized);
  const contactIds = extractLeadContactIds(record);
  if (contactIds.length > 0) normalized.contact_ids = contactIds;
  return normalized;
}

/** A record of `entity` in its stored shape. Input returned when untouched. */
export function normalizeClosePayload(entity: string, payload: Row): Row {
  if (entity === "leads") return normalizeCloseLeadRecord(payload);
  if (CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)) {
    const copy = { ...payload };
    flattenCloseCustomFields(copy);
    return copy;
  }
  return payload;
}

/** A Search API page in its stored shape. */
export function normalizeCloseSearchBatch(
  entity: string,
  data: unknown[],
): unknown[] {
  if (entity === "leads" || CUSTOM_FIELD_FLATTEN_ENTITIES.has(entity)) {
    return data.map(record =>
      normalizeClosePayload(entity, (record || {}) as Row),
    );
  }
  return data;
}
