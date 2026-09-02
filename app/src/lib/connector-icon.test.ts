import { describe, expect, it } from "vitest";
import { connectorIconUrl } from "./connector-icon";

describe("connectorIconUrl", () => {
  it("scopes workspace connector icons to the active workspace", () => {
    expect(connectorIconUrl("ws:acme/crm", "workspace 1")).toBe(
      "/api/connectors/ws%3Aacme%2Fcrm/icon.svg?workspaceId=workspace%201",
    );
  });

  it("keeps built-in connector icons public", () => {
    expect(connectorIconUrl("stripe", "workspace 1")).toBe(
      "/api/connectors/stripe/icon.svg",
    );
  });
});
