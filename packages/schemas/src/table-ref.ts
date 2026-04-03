import { nanoid } from "nanoid";

export function sanitizeTableRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "ds_table";
}

export function buildTableRef(name?: string): string {
  const base = name
    ? sanitizeTableRef(name.toLowerCase().replace(/\s+/g, "_")).slice(0, 40)
    : "ds";
  return sanitizeTableRef(`${base}_${nanoid(8)}`);
}
