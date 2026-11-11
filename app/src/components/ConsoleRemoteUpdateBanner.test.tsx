// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ConsoleRemoteUpdateBanner from "./ConsoleRemoteUpdateBanner";

afterEach(cleanup);

const noop = () => undefined;
const banner = (remoteUpdate: {
  kind: "updated" | "deleted";
  updatedBy?: string;
}) =>
  render(
    <ConsoleRemoteUpdateBanner
      remoteUpdate={{ draftRevision: 2, ...remoteUpdate }}
      onLoadLatest={noop}
      onDismiss={noop}
      onCloseTab={noop}
    />,
  );

describe("ConsoleRemoteUpdateBanner", () => {
  it("names another collaborator only when there is one", () => {
    banner({ kind: "updated", updatedBy: "someone" });
    expect(
      screen.getByText(/updated by another collaborator — your unsaved/),
    ).toBeTruthy();
    cleanup();
    banner({ kind: "updated" });
    expect(screen.getByText(/updated elsewhere — your unsaved/)).toBeTruthy();
  });

  it("does not say who deleted a console: the event does not tell", () => {
    banner({ kind: "deleted", updatedBy: "someone" });
    expect(screen.getByText("This console was deleted.")).toBeTruthy();
    expect(screen.queryByText(/another user/)).toBeNull();
  });
});
