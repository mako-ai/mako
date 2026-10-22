// Pure helpers behind @makoai/app-sdk's data hooks — no React and no
// DuckDB, so `node --test` can cover them without installing anything.

/** A SQL identifier, double-quoted (DuckDB folds case either way). */
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** A SQL string literal. */
export function quoteString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// String literals and comments first (skipped), then quoted and bare
// identifiers (kept).
const SQL_TOKENS = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)/g;

/**
 * The staged bindings whose names appear as identifiers in `sql`. A hint,
 * not a parse: a column that shares a binding's name costs one extra
 * download; a reference it misses is caught by the retry on DuckDB's
 * "Table with name … does not exist" error.
 */
export function mentionedBindings(sql, names) {
  if (!names.length) return [];
  const byLower = new Map();
  for (const n of names) {
    const key = n.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, n);
  }
  const found = new Set();
  for (const m of String(sql).matchAll(SQL_TOKENS)) {
    const ident = m[1] != null ? m[1].replace(/""/g, '"') : m[2];
    if (ident == null) continue;
    const hit = byLower.get(ident.toLowerCase());
    if (hit) found.add(hit);
  }
  return [...found];
}

// Queries that list tables instead of naming them (SHOW TABLES,
// information_schema, duckdb_tables() …) see every binding, as they did when
// all of them were registered up front.
const CATALOG_QUERY = /\b(?:information_schema|duckdb_(?:tables|columns|views|constraints|indexes)|sqlite_master|pg_catalog|show_tables)\b|\bshow\s+(?:all\s+)?tables\b/i;
export function readsCatalog(sql) {
  return CATALOG_QUERY.test(String(sql));
}

/**
 * The binding a DuckDB "Table with name X does not exist" error is about —
 * X itself when the index lists it, else its case-insensitive match (DuckDB
 * folds identifier case). null for any other error, or a name no binding has.
 */
export function missingBinding(message, names) {
  const m = /Table with name (.+?) does not exist/.exec(String(message));
  if (!m) return null;
  const table = m[1];
  if (names.includes(table)) return table;
  const lower = table.toLowerCase();
  return names.find(n => n.toLowerCase() === lower) ?? null;
}

// Arrow → plain JS, with the types apps actually want. DuckDB hands DATE and
// TIMESTAMP columns to JS as epoch milliseconds; v1 apps (JSON over the wire)
// always saw strings, and a migrated formatDate() that did
// new Date(`${d}T00:00:00`) on a number threw and unmounted the whole app
// (apps.md §15.4). So: DATE → "YYYY-MM-DD", TIMESTAMP → ISO 8601, BigInt →
// Number when it fits. Everything else passes through untouched.
const DATE = 1;
const TIMESTAMP = 2;
const OTHER = 0;
function columnKind(field) {
  const type = String(field.type);
  if (type.startsWith("Date")) return DATE;
  if (type.startsWith("Timestamp")) return TIMESTAMP;
  return OTHER;
}

// Fast paths for the two column types that dominate decode time. Each
// reads Arrow's buffers directly and yields exactly what Arrow's getter
// would; a chunk it does not fully understand returns null and the column
// takes the general path (Arrow's own iterator).
const UTF8 = 5; // arrow Type.Utf8
const TIMESTAMP_TYPE = 10; // arrow Type.Timestamp
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
let textDecoder = null;
function plainChunks(source, typeId) {
  const chunks = source.data;
  if (!Array.isArray(chunks) || !chunks.length) return null;
  for (const d of chunks) {
    if (!d || !d.type || d.type.typeId !== typeId || d.offset !== 0) return null;
    if (d.nullCount > 0 && typeof d.getValid !== "function") return null;
  }
  return chunks;
}

// Utf8: Arrow runs a TextDecoder per cell. A chunk whose bytes are all
// ASCII decodes in one call and slices by offset — the same strings.
function asciiColumn(source, n) {
  const chunks = plainChunks(source, UTF8);
  if (!chunks) return null;
  textDecoder ??= new TextDecoder();
  const out = new Array(n);
  let r = 0;
  for (const d of chunks) {
    const { values, valueOffsets, length } = d;
    if (!(values instanceof Uint8Array) || !(valueOffsets instanceof Int32Array)) return null;
    const start = valueOffsets[0];
    const end = valueOffsets[length];
    for (let i = start; i < end; i++) if (values[i] > 0x7f) return null;
    const text = textDecoder.decode(values.subarray(start, end));
    const nulls = d.nullCount > 0;
    for (let i = 0; i < length && r < n; i++) {
      out[r++] = nulls && !d.getValid(i)
        ? null
        : text.slice(valueOffsets[i] - start, valueOffsets[i + 1] - start);
    }
  }
  return out;
}

// Timestamp: Arrow divides BigInts per cell (getTimestampMicrosecond is
// `Number(v / 1000n) + Number(v % 1000n) / 1000`). Within ±2^53 the same
// quotient and remainder are exact in doubles, so the same two IEEE
// operations give the same millisecond value. A value outside that range
// sends the column to the general path.
function timestampColumn(source, n) {
  const chunks = plainChunks(source, TIMESTAMP_TYPE);
  if (!chunks) return null;
  const out = new Array(n);
  let r = 0;
  for (const d of chunks) {
    const { values, length } = d;
    if (!(values instanceof BigInt64Array)) return null;
    const unit = d.type.unit; // 0 s, 1 ms, 2 µs, 3 ns
    if (unit !== 0 && unit !== 1 && unit !== 2 && unit !== 3) return null;
    const nulls = d.nullCount > 0;
    for (let i = 0; i < length && r < n; i++) {
      if (nulls && !d.getValid(i)) {
        out[r++] = null;
        continue;
      }
      const v = Number(values[i]);
      if (v > MAX_SAFE || v < -MAX_SAFE) return null;
      let ms;
      if (unit === 0) ms = 1000 * v;
      else if (unit === 1) ms = v;
      else {
        const div = unit === 2 ? 1000 : 1000000;
        const rem = v % div;
        ms = (v - rem) / div + rem / div;
      }
      out[r++] = new Date(ms).toISOString();
    }
  }
  return out;
}

/**
 * An Arrow table as `{ rows, fields }`: one plain object per row, keyed by
 * column name, values normalized as above, at most `cap` rows.
 *
 * Column by column: each column's values come from Arrow's own vector
 * iterator (the same getter a row proxy's `row[name]` calls), so the output
 * is identical to walking `for (const row of table)` — without a Proxy trap
 * and a field-name lookup per cell, and with each distinct DATE formatted
 * once. 149k rows × 16 columns: 740 ms before, 190 ms after (Chromium).
 */
export function toPlainRows(table, cap) {
  const schemaFields = table.schema.fields;
  const fields = schemaFields.map(f => f.name);
  const limit = cap == null ? Infinity : cap;
  const n = Math.max(0, Math.min(table.numRows, limit));
  const rows = new Array(n);
  for (let r = 0; r < n; r++) rows[r] = {};
  for (let c = 0; c < fields.length; c++) {
    const name = fields[c];
    // A row proxy resolves a name to its FIRST column; a duplicated name
    // reads that column's values (decoded with this column's type).
    const source = table.getChildAt(fields.indexOf(name));
    const kind = columnKind(schemaFields[c]);
    let r = 0;
    if (n === 0 || !source) {
      for (; r < n; r++) rows[r][name] = undefined;
      continue;
    }
    const fast =
      kind === OTHER ? asciiColumn(source, n) : kind === TIMESTAMP ? timestampColumn(source, n) : null;
    if (fast) {
      for (; r < n; r++) rows[r][name] = fast[r];
      continue;
    }
    const dates = kind === DATE ? new Map() : null;
    for (const v of source) {
      if (r >= n) break;
      let out = v;
      if (v != null) {
        if (kind === DATE) {
          out = dates.get(v);
          if (out === undefined) {
            out = new Date(Number(v)).toISOString().slice(0, 10);
            dates.set(v, out);
          }
        } else if (kind === TIMESTAMP) out = new Date(Number(v)).toISOString();
        else if (typeof v === "bigint" && v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER)
          out = Number(v);
      }
      rows[r++][name] = out;
    }
  }
  return { rows, fields };
}
