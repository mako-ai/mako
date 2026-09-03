// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { reportClientToolFailure } from "./client-tool-failure-reporter";

beforeEach(() => {
  vi.restoreAllMocks();
});

it("reports failed client tools without forwarding their full output", () => {
  const request = vi.fn<typeof fetch>(async () => new Response());
  vi.stubGlobal("fetch", request);

  reportClientToolFailure({
    workspaceId: "workspace-1",
    chatId: "chat-1",
    toolName: "query_duckdb",
    toolCallId: "failure-1",
    output: { success: false, error: "Unknown surface kind: app", rows: [1] },
  });

  expect(request).toHaveBeenCalledOnce();
  const body = JSON.parse(request.mock.calls[0][1]?.body as string);
  expect(body).toEqual({
    workspaceId: "workspace-1",
    chatId: "chat-1",
    toolName: "query_duckdb",
    toolCallId: "failure-1",
    error: "Unknown surface kind: app",
  });
});

it("ignores successful client tools", () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);

  reportClientToolFailure({
    workspaceId: "workspace-1",
    chatId: "chat-1",
    toolName: "query_duckdb",
    toolCallId: "success-1",
    output: { success: true },
  });

  expect(request).not.toHaveBeenCalled();
});
