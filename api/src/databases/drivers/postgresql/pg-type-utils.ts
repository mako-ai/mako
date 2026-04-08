const POSTGRES_OID_TYPE_MAP: Record<number, string> = {
  16: "BOOLEAN",
  17: "BYTEA",
  18: "CHAR",
  20: "BIGINT",
  21: "SMALLINT",
  23: "INTEGER",
  25: "TEXT",
  26: "OID",
  114: "JSON",
  600: "POINT",
  601: "LSEG",
  602: "PATH",
  603: "BOX",
  604: "POLYGON",
  628: "LINE",
  650: "CIDR",
  700: "REAL",
  701: "DOUBLE PRECISION",
  718: "CIRCLE",
  829: "MACADDR",
  869: "INET",
  1000: "BOOLEAN[]",
  1005: "SMALLINT[]",
  1007: "INTEGER[]",
  1009: "TEXT[]",
  1015: "VARCHAR[]",
  1016: "BIGINT[]",
  1021: "REAL[]",
  1022: "DOUBLE PRECISION[]",
  1042: "CHAR",
  1043: "VARCHAR",
  1082: "DATE",
  1083: "TIME",
  1114: "TIMESTAMP",
  1184: "TIMESTAMPTZ",
  1186: "INTERVAL",
  1266: "TIMETZ",
  1700: "NUMERIC",
  2249: "RECORD",
  2287: "RECORD[]",
  2950: "UUID",
  3802: "JSONB",
  3904: "INT4RANGE",
  3906: "INT8RANGE",
  3908: "NUMRANGE",
  3910: "TSRANGE",
  3912: "DATERANGE",
  3914: "TSTZRANGE",
};

const INTEGER_TYPE_NAMES = new Set(["bigint", "smallint", "integer", "oid"]);

type PostgresFieldLike = {
  name?: string;
  columnName?: string;
  originalName?: string;
  type?: string;
  dataType?: string;
  columnType?: string;
  dataTypeID?: number;
};

function coerceSafeIntegerString(value: string): number | string {
  const trimmed = value.trim();
  if (!/^-?\d+$/u.test(trimmed)) {
    return value;
  }

  try {
    const parsed = BigInt(trimmed);
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (parsed <= max && parsed >= min) {
      return Number(trimmed);
    }
  } catch {
    return value;
  }

  return value;
}

function coerceFiniteNumberString(value: string): number | string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

export function mapPostgresOidToType(oid: number): string {
  return POSTGRES_OID_TYPE_MAP[oid] || "TEXT";
}

export function stripTrailingSqlSemicolon(query: string): string {
  return query.replace(/;\s*$/u, "").trim();
}

export function normalizePostgresFields<T extends PostgresFieldLike>(
  fields: T[] | undefined,
): Array<T & { type?: string }> {
  if (!Array.isArray(fields) || fields.length === 0) {
    return [];
  }

  return fields.map(field => ({
    ...field,
    type:
      typeof field.type === "string"
        ? field.type
        : typeof field.dataType === "string"
          ? field.dataType
          : typeof field.columnType === "string"
            ? field.columnType
            : typeof field.dataTypeID === "number"
              ? mapPostgresOidToType(field.dataTypeID)
              : undefined,
  }));
}

export function coercePostgresValue(
  value: unknown,
  fieldType: string | undefined,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= max && value >= min) {
      return Number(value);
    }
    return value.toString();
  }

  if (typeof value !== "string" || !fieldType) {
    return value;
  }

  const normalizedType = fieldType.toLowerCase();

  if (INTEGER_TYPE_NAMES.has(normalizedType)) {
    return coerceSafeIntegerString(value);
  }

  if (
    normalizedType.includes("double") ||
    normalizedType.includes("float") ||
    normalizedType.includes("real")
  ) {
    return coerceFiniteNumberString(value);
  }

  return value;
}

export function normalizePostgresRows(
  rows: Array<Record<string, unknown>>,
  fields: Array<{ name?: string; type?: string }> | undefined,
): Array<Record<string, unknown>> {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(fields)) {
    return rows;
  }

  const fieldTypes = new Map<string, string>();
  for (const field of fields) {
    if (field.name && field.type) {
      fieldTypes.set(String(field.name), String(field.type));
    }
  }

  if (fieldTypes.size === 0) {
    return rows;
  }

  return rows.map(row => {
    let nextRow: Record<string, unknown> | null = null;

    for (const [key, value] of Object.entries(row)) {
      const normalizedValue = coercePostgresValue(value, fieldTypes.get(key));
      if (normalizedValue !== value) {
        nextRow ||= { ...row };
        nextRow[key] = normalizedValue;
      }
    }

    return nextRow || row;
  });
}
