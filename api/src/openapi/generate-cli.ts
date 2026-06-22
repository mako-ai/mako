/* eslint-disable no-console, no-process-exit */
import fs from "fs";
import path from "path";

import { buildOpenApiDocument } from "./document";

/**
 * Writes the generated OpenAPI document to disk (default:
 * `docs/src/openapi/mako-api.json`, consumed by the Starlight docs site).
 *
 * Usage:
 *   tsx src/openapi/generate-cli.ts [outputPath]
 *
 * This is a build-time helper; it does not start the server or touch the
 * database — it builds the document from the Zod route definitions.
 */
function main(): void {
  const outArg = process.argv[2];
  const defaultOut = path.resolve(
    __dirname,
    "../../../docs/src/openapi/mako-api.json",
  );
  const outPath = outArg ? path.resolve(process.cwd(), outArg) : defaultOut;

  const document = buildOpenApiDocument();
  const json = `${JSON.stringify(document, null, 2)}\n`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");

  const paths = document.paths ?? {};
  const operationCount = Object.values(paths).reduce(
    (total, item) => total + Object.keys(item as object).length,
    0,
  );
  console.log(
    `Wrote OpenAPI spec: ${operationCount} operations across ` +
      `${Object.keys(paths).length} paths -> ${outPath}`,
  );

  // Imported route modules register services that keep the event loop alive
  // (timers, pools). The spec is fully written synchronously above, so exit.
  process.exit(0);
}

main();
