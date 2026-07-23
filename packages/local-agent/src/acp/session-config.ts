/**
 * Helpers for ACP session/configOptions (model picker, etc.).
 */

export interface AcpModelChoice {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionSnapshot {
  id: string;
  name: string;
  category?: string | null;
  type: "select" | "boolean" | string;
  currentValue?: string | boolean | null;
  options?: AcpModelChoice[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function flattenSelectOptions(options: unknown): AcpModelChoice[] {
  if (!Array.isArray(options)) return [];
  const out: AcpModelChoice[] = [];
  for (const entry of options) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (typeof rec.value === "string" && rec.value) {
      out.push({
        value: rec.value,
        name:
          typeof rec.name === "string" && rec.name.trim()
            ? rec.name
            : rec.value,
        description:
          typeof rec.description === "string" ? rec.description : undefined,
      });
      continue;
    }
    if (Array.isArray(rec.options)) {
      out.push(...flattenSelectOptions(rec.options));
    }
  }
  return out;
}

export function parseConfigOptions(
  raw: unknown,
): AcpConfigOptionSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpConfigOptionSnapshot[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec || typeof rec.id !== "string" || !rec.id) continue;
    const type = typeof rec.type === "string" ? rec.type : "select";
    const snap: AcpConfigOptionSnapshot = {
      id: rec.id,
      name: typeof rec.name === "string" && rec.name.trim() ? rec.name : rec.id,
      category: typeof rec.category === "string" ? rec.category : null,
      type,
      currentValue:
        typeof rec.currentValue === "string" ||
        typeof rec.currentValue === "boolean"
          ? rec.currentValue
          : null,
    };
    if (type === "select") {
      snap.options = flattenSelectOptions(rec.options);
    }
    out.push(snap);
  }
  return out;
}

/** Prefer category "model", else config id "model". */
export function findModelConfigOption(
  options: AcpConfigOptionSnapshot[],
): AcpConfigOptionSnapshot | null {
  return (
    options.find(
      o => o.category === "model" && o.type === "select" && o.options?.length,
    ) ||
    options.find(o => o.id === "model" && o.type === "select") ||
    null
  );
}

export function modelChoicesFromConfigOptions(
  options: AcpConfigOptionSnapshot[],
): AcpModelChoice[] {
  return findModelConfigOption(options)?.options ?? [];
}

export function currentModelFromConfigOptions(
  options: AcpConfigOptionSnapshot[],
): string | null {
  const model = findModelConfigOption(options);
  return typeof model?.currentValue === "string" ? model.currentValue : null;
}
