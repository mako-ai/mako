import { describe, expect, it } from "vitest";
import { acpProviderLabel } from "./acp-provider-label";
import type { AcpStatus } from "./acp-types";

const status: AcpStatus = {
  available: true,
  defaultCwd: "/tmp",
  providers: [
    {
      id: "claude",
      label: "Claude Code",
      description: "",
      authProduct: "Claude",
      installHint: "",
      adapterCommand: null,
      adapterFound: true,
      connected: false,
      authRequired: false,
      authMethods: [],
    },
    {
      id: "codex",
      label: "Codex",
      description: "",
      authProduct: "ChatGPT",
      installHint: "",
      adapterCommand: null,
      adapterFound: true,
      connected: false,
      authRequired: false,
      authMethods: [],
    },
  ],
};

describe("acpProviderLabel", () => {
  it("uses status label when present", () => {
    expect(acpProviderLabel("codex", status)).toBe("Codex");
    expect(acpProviderLabel("claude", status)).toBe("Claude Code");
  });

  it("falls back by provider id", () => {
    expect(acpProviderLabel("codex")).toBe("Codex");
    expect(acpProviderLabel("claude")).toBe("Claude Code");
  });
});
