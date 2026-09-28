import { describe, expect, it } from "vitest";
import {
  REDACTED,
  collectProfileSecrets,
  createSecretRedactor,
} from "./log-redaction";

const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nqL3r0dKf9sT2mYpZ8wQx\n-----END PRIVATE KEY-----\n";

const profile = {
  secretEnv: {
    DBT_SECRET_PASSWORD: "hunter2-postgres-pw",
    DBT_SECRET_PORT: "5432",
  },
  keyfiles: [
    {
      envVar: "DBT_BQ_KEYFILE",
      filename: ".dbt-bq-keyfile.json",
      content: JSON.stringify({
        type: "service_account",
        client_email: "runner@proj.iam.gserviceaccount.com",
        private_key_id: "0123456789abcdef0123",
        private_key: PRIVATE_KEY,
      }),
    },
  ],
};

// Review finding (#1013, HIGH): uploaded dbt code can print env_var()
// secrets into the log that streams back to the laptop.
describe("run log redaction", () => {
  const redact = createSecretRedactor(collectProfileSecrets(profile));

  it("scrubs injected secret env values", () => {
    expect(redact("password is hunter2-postgres-pw!")).toBe(
      `password is ${REDACTED}!`,
    );
  });

  it("scrubs a keyfile's private key, whole, escaped or line by line", () => {
    expect(redact(`key=${PRIVATE_KEY}`)).not.toContain("MIIEvQIBADAN");
    expect(redact(JSON.stringify(PRIVATE_KEY))).not.toContain("MIIEvQIBADAN");
    expect(
      redact("  MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"),
    ).toBe(`  ${REDACTED}`);
    expect(redact("id 0123456789abcdef0123")).toBe(`id ${REDACTED}`);
  });

  it("leaves non-secret fields and short values alone", () => {
    expect(redact("as runner@proj.iam.gserviceaccount.com on port 5432")).toBe(
      "as runner@proj.iam.gserviceaccount.com on port 5432",
    );
  });

  it("is a no-op without secrets", () => {
    expect(createSecretRedactor([])("anything")).toBe("anything");
  });
});
