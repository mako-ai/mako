import { afterEach, describe, expect, it } from "vitest";
import { createAppsScaffold } from "../scaffold";
import { launcherSource } from "../dev-server/launcher";
import {
  DEFAULT_E2B_DOMAIN,
  e2bDomain,
  e2bStartupInfo,
  previewHostSuffix,
  viteAllowedHostEnv,
} from "./e2b-domain";

const saved = process.env.E2B_DOMAIN;
afterEach(() => {
  if (saved === undefined) delete process.env.E2B_DOMAIN;
  else process.env.E2B_DOMAIN = saved;
});

describe("e2bDomain", () => {
  it("defaults to e2b.app when unset or blank", () => {
    expect(e2bDomain({})).toBe(DEFAULT_E2B_DOMAIN);
    expect(e2bDomain({ E2B_DOMAIN: "" })).toBe("e2b.app");
    expect(e2bDomain({ E2B_DOMAIN: "   " })).toBe("e2b.app");
  });

  it("reads the EU domain", () => {
    expect(e2bDomain({ E2B_DOMAIN: "e2b-juliett.dev" })).toBe(
      "e2b-juliett.dev",
    );
  });

  it("trims, lowercases and drops a leading dot", () => {
    expect(e2bDomain({ E2B_DOMAIN: " .E2B-Juliett.DEV\n" })).toBe(
      "e2b-juliett.dev",
    );
  });

  it.each([
    "https://e2b-juliett.dev",
    "e2b-juliett.dev/",
    "e2b-juliett.dev:443",
    "localhost",
    "e2b..dev",
    "-e2b.dev",
    'e2b.dev"],x:[1',
  ])("rejects %j", value => {
    expect(() => e2bDomain({ E2B_DOMAIN: value })).toThrow(/E2B_DOMAIN/);
  });
});

describe("previewHostSuffix", () => {
  it("is a suffix match on the domain", () => {
    expect(previewHostSuffix("e2b.app")).toBe(".e2b.app");
    expect(previewHostSuffix("e2b-juliett.dev")).toBe(".e2b-juliett.dev");
  });

  it("follows E2B_DOMAIN by default", () => {
    delete process.env.E2B_DOMAIN;
    expect(previewHostSuffix()).toBe(".e2b.app");
    process.env.E2B_DOMAIN = "e2b-juliett.dev";
    expect(previewHostSuffix()).toBe(".e2b-juliett.dev");
  });

  it("feeds Vite's additional allowed hosts env", () => {
    process.env.E2B_DOMAIN = "e2b-juliett.dev";
    expect(viteAllowedHostEnv()).toEqual({
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b-juliett.dev",
    });
  });
});

describe("launcher and scaffold follow E2B_DOMAIN", () => {
  const launcher = () =>
    launcherSource("/app", 5173, "/data", "sales", "/box.env", {});

  it("writes .e2b.app into both when unset", () => {
    delete process.env.E2B_DOMAIN;
    expect(launcher()).toContain('allowedHosts: [".e2b.app"]');
    expect(createAppsScaffold({ title: "x" })["vite.config.ts"]).toContain(
      'allowedHosts: [".e2b.app"]',
    );
  });

  it("writes the EU host into both when set", () => {
    process.env.E2B_DOMAIN = "e2b-juliett.dev";
    const source = launcher();
    expect(source).toContain('allowedHosts: [".e2b-juliett.dev"]');
    expect(source).not.toContain('".e2b.app"');
    expect(createAppsScaffold({ title: "x" })["vite.config.ts"]).toContain(
      'allowedHosts: [".e2b-juliett.dev"]',
    );
  });
});

describe("e2bStartupInfo", () => {
  it("names the domain and never the key", () => {
    const key = "e2b_secret_value_123";
    const info = e2bStartupInfo({
      E2B_DOMAIN: "e2b-juliett.dev",
      E2B_API_KEY: key,
    });
    expect(info).toEqual({
      provider: "e2b",
      domain: "e2b-juliett.dev",
      apiHost: "api.e2b-juliett.dev",
      previewHostSuffix: ".e2b-juliett.dev",
      apiKeySet: true,
    });
    expect(JSON.stringify(info)).not.toContain(key);
  });

  it("reports a missing key", () => {
    expect(e2bStartupInfo({}).apiKeySet).toBe(false);
    expect(e2bStartupInfo({}).domain).toBe("e2b.app");
  });
});
