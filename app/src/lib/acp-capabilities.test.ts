import { describe, expect, it } from "vitest";
import {
  ACP_REQUIRED_DESKTOP_VERSION,
  acpDesktopOutdatedSummary,
  acpIsDesktopOutdatedForEnsureWarm,
  acpSupportsAdapterEnsure,
  acpSupportsModelWarm,
  acpSupportsWorkspaceMcp,
} from "./acp-capabilities";
import type { AcpStatus } from "./acp-types";

function status(bridge?: AcpStatus["acpBridge"]): AcpStatus {
  return {
    available: true,
    defaultCwd: "/tmp",
    providers: [],
    acpBridge: bridge,
  };
}

describe("acp capabilities", () => {
  it("requires bridge ≥ 2 for workspace MCP", () => {
    expect(acpSupportsWorkspaceMcp(null)).toBe(false);
    expect(acpSupportsWorkspaceMcp(status({ version: 1 }))).toBe(false);
    expect(acpSupportsWorkspaceMcp(status({ version: 2 }))).toBe(true);
  });

  it("gates ensure/warm on bridge ≥ 7 or capability flags", () => {
    expect(acpSupportsAdapterEnsure(status({ version: 5 }))).toBe(false);
    expect(acpSupportsModelWarm(status({ version: 5 }))).toBe(false);
    expect(acpSupportsAdapterEnsure(status({ version: 6 }))).toBe(false);
    expect(acpSupportsModelWarm(status({ version: 6 }))).toBe(false);
    expect(acpSupportsAdapterEnsure(status({ version: 7 }))).toBe(true);
    expect(acpSupportsModelWarm(status({ version: 7, modelWarm: true }))).toBe(
      true,
    );
    expect(
      acpSupportsAdapterEnsure(status({ version: 3, adapterEnsure: true })),
    ).toBe(true);
  });

  it("treats missing ensure/warm as first-class Desktop outdated", () => {
    expect(acpIsDesktopOutdatedForEnsureWarm(null)).toBe(false);
    expect(acpIsDesktopOutdatedForEnsureWarm(status())).toBe(false);
    expect(acpIsDesktopOutdatedForEnsureWarm(status({ version: 5 }))).toBe(
      true,
    );
    expect(
      acpIsDesktopOutdatedForEnsureWarm(
        status({ version: 7, adapterEnsure: true, modelWarm: true }),
      ),
    ).toBe(false);
    expect(acpDesktopOutdatedSummary()).toContain(ACP_REQUIRED_DESKTOP_VERSION);
    expect(acpDesktopOutdatedSummary()).toMatch(/fully quit/i);
    expect(acpDesktopOutdatedSummary()).toMatch(/Enable workspace tools/i);
  });
});
