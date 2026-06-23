/**
 * Read a nested value from an object using a dot-delimited path
 * (e.g. `"data.items"`). Returns `null` if any segment is missing and the
 * original object when the path is empty.
 *
 * Shared by HTTP connectors (REST, GraphQL) that extract data/pagination
 * fields from arbitrary JSON responses, so the traversal logic lives in one
 * place instead of being copy-pasted per connector.
 */
export function getValueByPath(obj: any, path: string): any {
  if (!path) return obj;
  return path.split(".").reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}
