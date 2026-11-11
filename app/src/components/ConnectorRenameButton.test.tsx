// @vitest-environment jsdom
/**
 * "Rename…" on a workspace connector: the slug is checked as it is typed
 * with the server's own rule, the server's refusal is shown as it is and
 * cleared on edit, and a rename reports the new slug.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorSlugError } from "@mako/schemas";

const workspace = vi.hoisted(() => ({ role: "member" }));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "wsA", ...workspace } }),
}));

import { ConnectorRenameButton } from "./ConnectorRenameButton";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

const rename = vi.fn();
const onRenamed = vi.fn();
const original = useConnectorCatalogStore.getState().renameWorkspaceConnector;

function open() {
  render(<ConnectorRenameButton slug="acme" onRenamed={onRenamed} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
  const input = screen.getByLabelText("Connector slug") as HTMLInputElement;
  const submit = screen.getByRole("button", { name: "Rename" });
  const type = (value: string) =>
    fireEvent.change(input, { target: { value } });
  return { input, submit, type };
}

beforeEach(() => {
  workspace.role = "member";
  rename.mockReset();
  onRenamed.mockReset();
  useConnectorCatalogStore.setState({ renameWorkspaceConnector: rename });
});
afterEach(() => {
  cleanup();
  useConnectorCatalogStore.setState({ renameWorkspaceConnector: original });
});

describe("ConnectorRenameButton", () => {
  it("starts from the current slug and refuses a bad one as it is typed, in the server's words", () => {
    const { input, submit, type } = open();
    expect(input.value).toBe("acme");
    expect(submit).toHaveProperty("disabled", true); // nothing to change

    for (const bad of ["Acme CRM", "2026", "con", "a".repeat(65)]) {
      type(bad);
      expect(screen.getByText(connectorSlugError(bad) as string)).toBeTruthy();
      expect(submit).toHaveProperty("disabled", true);
    }
    type("  ");
    expect(submit).toHaveProperty("disabled", true);
    type(" acme-crm ");
    expect(submit).toHaveProperty("disabled", false);
    expect(rename).not.toHaveBeenCalled();
  });

  it("shows the server's sentence when it refuses, clears it on edit, and reports the new slug once renamed", async () => {
    const taken = 'A connector "zed" already exists';
    rename.mockResolvedValueOnce({ error: taken });
    const { submit, type } = open();
    type("zed");
    fireEvent.click(submit);
    expect(await screen.findByText(taken)).toBeTruthy();
    expect(rename).toHaveBeenCalledWith("wsA", "acme", "zed");
    expect(onRenamed).not.toHaveBeenCalled();

    type("acme-crm ");
    expect(screen.queryByText(taken)).toBeNull();
    rename.mockResolvedValueOnce({ slug: "acme-crm" });
    fireEvent.click(submit);
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("acme-crm"));
    expect(rename).toHaveBeenLastCalledWith("wsA", "acme", "acme-crm");
    await waitFor(() =>
      expect(screen.queryByLabelText("Connector slug")).toBeNull(),
    );
  });

  it("is not offered to a viewer", () => {
    workspace.role = "viewer";
    render(<ConnectorRenameButton slug="acme" onRenamed={onRenamed} />);
    expect(screen.queryByRole("button", { name: "Rename…" })).toBeNull();
  });
});
