/**
 * dbt-core versions the Mako runner can resolve (see api/src/dbt/dbt-bin.ts).
 * Store the minor release track on the project; patch is pinned at runtime.
 */
export const DEFAULT_DBT_VERSION = "1.9";

export const DBT_VERSION_OPTIONS: Array<{
  value: string;
  label: string;
  description?: string;
}> = [
  {
    value: "1.9",
    label: "1.9 — recommended",
    description: "dbt-core 1.9.x (Fusion-compatible projects)",
  },
  {
    value: "1.8",
    label: "1.8",
    description: "dbt-core 1.8.x",
  },
  {
    value: "1.7",
    label: "1.7 — legacy",
    description: "Required for some MySQL adapter projects",
  },
];

export function isKnownDbtVersion(value: string): boolean {
  return DBT_VERSION_OPTIONS.some(o => o.value === value);
}

export function normalizeDbtVersion(value: string | undefined): string {
  if (value && isKnownDbtVersion(value)) return value;
  return DEFAULT_DBT_VERSION;
}

export function dbtVersionLabel(value: string | undefined): string {
  if (!value) return "—";
  const opt = DBT_VERSION_OPTIONS.find(o => o.value === value);
  return opt?.label ?? value;
}
