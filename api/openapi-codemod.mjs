/**
 * One-off codemod: wraps `router.METHOD("path"[, ...middleware], async (c...) => {`
 * registrations in `router.openapi(createRoute({...}), async c => {` for a given
 * router variable, deriving path params (plus prefix params) and a permissive
 * response set. Handler bodies and their closings are left untouched.
 *
 * Usage: node openapi-codemod.mjs <file> <routerVar> <Tag> <prefixParamsCsv>
 */
import fs from "fs";

const [file, routerVar, tag, prefixCsv = ""] = process.argv.slice(2);
const prefixParams = prefixCsv ? prefixCsv.split(",").filter(Boolean) : [];
let src = fs.readFileSync(file, "utf8");

const re = new RegExp(
  `${routerVar}\\.(get|post|put|patch|delete)\\(\\s*"([^"]+)",([\\s\\S]*?)async\\s*\\(?\\s*c(?::[^)]*)?\\)?\\s*=>\\s*\\{`,
  "g",
);

let count = 0;
src = src.replace(re, (_m, method, path, mwBlock) => {
  count++;
  const localParams = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map(x => x[1]);
  const allParams = [...new Set([...prefixParams, ...localParams])];
  const openapiPath = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

  const mw = mwBlock
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
  const mwLine = mw ? `    middleware: [${mw}] as const,\n` : "";

  const reqParts = [];
  if (allParams.length) {
    reqParts.push(
      `params: z.object({ ${allParams
        .map(p => `${p}: z.string().openapi({ param: { name: "${p}", in: "path" } })`)
        .join(", ")} })`,
    );
  }
  if (method === "post" || method === "put" || method === "patch") {
    reqParts.push(
      `body: { required: false, content: { "application/json": { schema: z.record(z.string(), z.any()) } } }`,
    );
  }
  const requestLine = reqParts.length
    ? `    request: { ${reqParts.join(", ")} },\n`
    : "";

  return (
    `${routerVar}.openapi(\n` +
    `  createRoute({\n` +
    `    method: "${method}",\n` +
    `    path: "${openapiPath}",\n` +
    `    tags: ["${tag}"],\n` +
    `    summary: "${method.toUpperCase()} ${openapiPath}",\n` +
    `    security: AUTH_SECURITY,\n` +
    mwLine +
    requestLine +
    `    responses: { ...OPEN_RESPONSES },\n` +
    `  }),\n` +
    `  async c => {`
  );
});

fs.writeFileSync(file, src, "utf8");
// eslint-disable-next-line no-console
console.log(`Wrapped ${count} routes for ${routerVar} in ${file}`);
