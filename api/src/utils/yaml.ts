import * as yaml from "js-yaml";

/**
 * js-yaml 4's default load schema, rebuilt on js-yaml 5.
 *
 * js-yaml 5 defaults to the YAML 1.2 core schema, which stops merging `<<`
 * keys and leaves unquoted timestamps as strings. The YAML we load is written
 * by people and already committed to workspace repos (flows, dbt jobs,
 * connectors, skills, notebooks), so a parser upgrade must not change what it
 * means.
 */
const LOAD_SCHEMA = yaml.CORE_SCHEMA.withTags(
  yaml.timestampTag,
  yaml.mergeTag,
  yaml.binaryTag,
  yaml.omapTag,
  yaml.pairsTag,
  yaml.setTag,
);

/**
 * Parse one YAML document. Empty and comment-only input yields `undefined`,
 * as js-yaml 4 did (5 throws "the input is empty").
 */
export function loadYaml(source: string): unknown {
  const hasContent = source
    .split("\n")
    .some(line => line.trim() !== "" && !line.trim().startsWith("#"));
  if (!hasContent) return undefined;
  return yaml.load(source, { schema: LOAD_SCHEMA });
}
