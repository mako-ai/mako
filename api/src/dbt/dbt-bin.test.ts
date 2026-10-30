import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DBT_PYTHONWARNINGS, buildDbtBaseEnv } from "./dbt-bin";

describe("buildDbtBaseEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("never leaks server secrets to the dbt child env", () => {
    process.env.ENCRYPTION_KEY = "super-secret-key";
    process.env.SESSION_SECRET = "session-secret";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN-----";
    process.env.AI_GATEWAY_API_KEY = "gw-key";
    process.env.DATABASE_URL = "mongodb://localhost/x";

    const env = buildDbtBaseEnv();

    expect(env).not.toHaveProperty("ENCRYPTION_KEY");
    expect(env).not.toHaveProperty("SESSION_SECRET");
    expect(env).not.toHaveProperty("GITHUB_APP_PRIVATE_KEY");
    expect(env).not.toHaveProperty("AI_GATEWAY_API_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(Object.values(env)).not.toContain("super-secret-key");
  });

  it("forwards the allowlisted runtime vars and UV_* config", () => {
    process.env.PATH = "/usr/bin:/bin";
    process.env.HTTPS_PROXY = "http://proxy.local:8080";
    process.env.UV_INDEX_URL = "https://pypi.internal/simple";

    const env = buildDbtBaseEnv();

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy.local:8080");
    expect(env.UV_INDEX_URL).toBe("https://pypi.internal/simple");
  });

  it("silences Python FutureWarnings unless the operator sets a filter", () => {
    delete process.env.PYTHONWARNINGS;
    expect(buildDbtBaseEnv().PYTHONWARNINGS).toBe(DEFAULT_DBT_PYTHONWARNINGS);
    expect(DEFAULT_DBT_PYTHONWARNINGS).toBe("ignore::FutureWarning");

    process.env.PYTHONWARNINGS = "default";
    expect(buildDbtBaseEnv().PYTHONWARNINGS).toBe("default");
  });
});
