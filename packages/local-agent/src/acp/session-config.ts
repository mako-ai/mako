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

/**
 * Map short Chat preferences (`opus`, `sonnet`, `fable`) to adapter-canonical
 * model ids (`claude-opus-4-6`, …). Older Claude ACP builds reject aliases
 * with a bare "Not Found" / invalid value error.
 */
/** When the adapter has not advertised models yet (warm failed / old agent). */
const CLAUDE_ALIAS_CANONICAL: Record<string, string> = {
  sonnet: "claude-sonnet-4-5",
  opus: "claude-opus-4-6",
  fable: "claude-fable-5",
  haiku: "claude-haiku-4-5",
};

export function resolveModelConfigValue(
  preferred: string,
  available: AcpModelChoice[] | undefined | null,
): string {
  const pref = preferred.trim();
  if (!pref) return pref;
  const list = available ?? [];
  if (list.length === 0) {
    return CLAUDE_ALIAS_CANONICAL[pref.toLowerCase()] ?? pref;
  }

  const prefLower = pref.toLowerCase();
  const exact = list.find(m => m.value.toLowerCase() === prefLower);
  if (exact) return exact.value;

  const token = prefLower.replace(/[^a-z0-9]+/g, "");
  if (!token) return pref;

  let best: { value: string; score: number } | null = null;
  for (const choice of list) {
    const value = choice.value.trim();
    if (!value || value.toLowerCase() === "default") continue;
    const v = value.toLowerCase();
    const n = (choice.name || "").toLowerCase();
    let score = 0;
    if (
      v.includes(`-${token}-`) ||
      v.endsWith(`-${token}`) ||
      v.startsWith(`${token}-`)
    ) {
      score = 80;
    } else if (v.includes(token)) {
      score = 60;
    } else if (
      n === prefLower ||
      n.split(/[^a-z0-9]+/).includes(token)
    ) {
      score = 50;
    } else if (n.includes(prefLower)) {
      score = 40;
    }
    if (score === 0) continue;
    // Prefer longer canonical ids when scores tie.
    if (
      !best ||
      score > best.score ||
      (score === best.score && value.length > best.value.length)
    ) {
      best = { value, score };
    }
  }
  return best?.value ?? pref;
}
