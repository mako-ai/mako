import { describe, expect, it } from "vitest";
import {
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

  it("gates ensure/warm on bridge ≥ 6 or capability flags", () => {
    expect(acpSupportsAdapterEnsure(status({ version: 5 }))).toBe(false);
    expect(acpSupportsModelWarm(status({ version: 5 }))).toBe(false);
    expect(acpSupportsAdapterEnsure(status({ version: 6 }))).toBe(true);
    expect(acpSupportsModelWarm(status({ version: 7, modelWarm: true }))).toBe(
      true,
    );
    expect(
      acpSupportsAdapterEnsure(status({ version: 3, adapterEnsure: true })),
    ).toBe(true);
  });
});
