import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { syncConnectorRegistry } from "../sync/connector-registry";
import { isSecretField } from "../agent-lib/tools/connector-tools";

/**
 * Every connector's credential fields must be marked for encryption.
 *
 * Connector secrets are not encrypted by the model. `applySchemaEncryption`
 * in routes/source-connections.ts encrypts a field only when that connector's OWN config
 * schema marks it `encrypted: true` or `type: "password"`. So protection is
 * per-connector metadata, and a new connector that omits the marker stores
 * its API key in plaintext — silently, with a 201.
 *
 * Worse, that helper fails OPEN by construction:
 *
 *     try { target[key] = encryptString(val); }
 *     catch { target[key] = val; }   // "If encryption fails, leave as-is"
 *
 * so an encryption error also stores plaintext and still returns success.
 * Nothing central enforces either property; this test is that enforcement.
 *
 * It is a census, not a spot check: it walks EVERY connector directory,
 * because "the ones I thought of" is how two production ClickHouse
 * connections kept handing back their credentials through two rounds of
 * fixes (#909, #915).
 */

const CONNECTORS_DIR = __dirname;

/**
 * Field names that hold a credential. Deliberately broad — a false positive
 * costs one `encrypted: true`, a false negative costs a plaintext secret.
 */
const CREDENTIAL_NAME =
  /pass(word|wd)?|secret|token|api[_-]?key|apikey|private[_-]?key|service_account|credential|bearer/i;

/** Known non-secrets whose NAME trips the pattern. Each needs a reason. */
const NOT_A_SECRET: Record<string, string> = {
  "posthog.auth_type":
    "selects WHICH credential to use (personal vs project key); the key itself is posthog.api_key",
};

function connectorTypes(): string[] {
  return readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "base")
    .map(entry => entry.name)
    .filter(name => existsSync(join(CONNECTORS_DIR, name, "connector.ts")))
    .sort();
}

async function main() {
  const types = connectorTypes();

  // A census whose subject is empty passes vacuously. The first version of
  // this check enumerated the registry, found zero connectors, and cheerfully
  // reported that every field was protected.
  assert.ok(
    types.length >= 10,
    `expected to find the connector directories, found ${types.length} — enumeration is broken, and a census of nothing proves nothing`,
  );

  const unprotected: string[] = [];
  let fieldCount = 0;
  let schemaCount = 0;

  for (const type of types) {
    const schema = (await syncConnectorRegistry
      .getConfigSchemaForType(type)
      .catch(() => null)) as { fields?: unknown } | null;

    if (!Array.isArray(schema?.fields)) {
      // No schema means applySchemaEncryption is a no-op for this connector:
      // every field it stores, credential or not, is stored as given.
      unprotected.push(
        `${type}: NO CONFIG SCHEMA — applySchemaEncryption cannot protect anything it stores`,
      );
      continue;
    }
    schemaCount++;

    const walk = (fields: unknown[], path: string): void => {
      for (const raw of fields) {
        const field = (raw ?? {}) as {
          name?: unknown;
          type?: unknown;
          encrypted?: boolean;
          itemFields?: unknown;
        };
        const name = path
          ? `${path}.${String(field.name)}`
          : String(field.name);
        fieldCount++;

        if (field.type === "object_array" && Array.isArray(field.itemFields)) {
          walk(field.itemFields, name);
        }

        const qualified = `${type}.${name}`;
        if (!CREDENTIAL_NAME.test(name)) continue;
        if (qualified in NOT_A_SECRET) continue;

        const protectedField = isSecretField({
          encrypted: field.encrypted,
          type: typeof field.type === "string" ? field.type : undefined,
        });
        if (!protectedField) {
          unprotected.push(
            `${qualified} (type=${String(field.type)}) is credential-shaped but is neither \`encrypted: true\` nor \`type: "password"\`, so it is stored in PLAINTEXT`,
          );
        }
      }
    };

    walk(schema.fields as unknown[], "");
  }

  assert.equal(
    unprotected.length,
    0,
    `connector credentials stored unencrypted:\n  ${unprotected.join("\n  ")}\n\nMark the field \`encrypted: true\` (or \`type: "password"\`) in its connector's getConfigSchema, or add it to NOT_A_SECRET with a reason.`,
  );

  // The allowlist must not rot into a way of silencing real findings.
  for (const key of Object.keys(NOT_A_SECRET)) {
    const [type] = key.split(".");
    assert.ok(
      types.includes(type),
      `NOT_A_SECRET names connector "${type}", which no longer exists — remove the entry rather than leaving a stale exemption`,
    );
  }

  // The tool that TELLS an agent which fields are secret must use the same
  // rule the route uses to encrypt them, or the two drift apart silently.
  const source = readFileSync(
    join(__dirname, "../routes/source-connections.ts"),
    "utf8",
  );
  assert.ok(
    /field\.encrypted === true \|\| field\.type === "password"/.test(source),
    "applySchemaEncryption's rule changed — isSecretField in connector-tools.ts mirrors it and must be updated together",
  );

  console.log(
    `connector credential census passed: ${types.length} connectors, ${schemaCount} with schemas, ${fieldCount} fields, 0 unencrypted credentials`,
  );
}

main().catch((error: unknown) => {
  throw error;
});
