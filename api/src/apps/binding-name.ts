/**
 * A binding's name is its file name (`bindings/<name>.sql`) and a path
 * segment of the URLs that serve it (`__data/<name>.parquet`), so it is held
 * to one safe alphabet everywhere: no dots, slashes or leading dash.
 */
const BINDING_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export function isValidBindingName(name: string): boolean {
  return BINDING_NAME_RE.test(name);
}
