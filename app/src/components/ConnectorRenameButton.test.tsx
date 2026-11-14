// @vitest-environment jsdom
/**
 * "Rename…" on a workspace connector: the dialog says what it renames (the
 * folder and the type id, not the display name), the slug is checked as it
 * is typed with the server's own rule, the server's refusal is shown as it
 * is and cleared on edit, a rename reports the new slug, and the button is
 * disabled, with the reason, for people the server would refuse.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectorSlugError, unsafeSlugReason } from "@mako/schemas";

const workspace = vi.hoisted(() => ({
  role: "member" as string | undefined,
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "wsA", ...workspace } }),
}));

import { ConnectorRenameButton } from "./ConnectorRenameButton";
import {
  CONNECTOR_RENAME_REFUSAL,
  canRenameConnector,
  connectorRenamedMessage,
} from "../lib/connector-rename";
import { useConnectorCatalogStore } from "../store/connectorCatalogStore";

const rename = vi.fn();
const onRenamed = vi.fn();
const original = useConnectorCatalogStore.getState().renameWorkspaceConnector;

function open() {
  render(
    <ConnectorRenameButton
      slug="acme"
      displayName="Acme CRM"
      onRenamed={onRenamed}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
  const input = screen.getByLabelText("Folder slug") as HTMLInputElement;
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
  it("says what it renames: the folder and the type id, not the display name, and where that name is changed", () => {
    const { type } = open();
    const said = screen.getByRole("dialog").textContent ?? "";
    expect(screen.getByText("Rename connector folder")).toBeTruthy();
    expect(said).toContain("connectors/acme/");
    expect(said).toContain("type id, ws:acme");
    expect(said).toMatch(
      /does not change the display name "Acme CRM" shown in lists: that is name in the connector's code/,
    );
    expect(screen.getByText("Type id: ws:acme")).toBeTruthy();
    type("acme-sales");
    expect(screen.getByText("Type id: ws:acme-sales")).toBeTruthy();
    expect(connectorRenamedMessage("acme-sales", "Acme CRM")).toBe(
      "The connector's folder is now connectors/acme-sales/ and its type id ws:acme-sales. " +
        'Its display name "Acme CRM" did not change: the display name is `name` in the connector\'s code.',
    );
  });

  it("starts from the current slug and refuses a bad one as it is typed, in the server's words", () => {
    const { input, submit, type } = open();
    expect(input.value).toBe("acme");
    expect(submit).toHaveProperty("disabled", true); // nothing to change

    const id = "0123456789abcdef01234567";
    for (const bad of ["Acme CRM", "2026", "con", "a".repeat(65), id]) {
      type(bad);
      expect(screen.getByText(connectorSlugError(bad) as string)).toBeTruthy();
      expect(submit).toHaveProperty("disabled", true);
    }
    // A name that reads as an id gets the sentence the other kinds give it.
    expect(connectorSlugError(id)).toMatch(/looks like an object id/);
    expect(connectorSlugError(id)).toBe(unsafeSlugReason(id));
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
      expect(screen.queryByLabelText("Folder slug")).toBeNull(),
    );
  });

  it("is offered to the people the server lets rename; for anyone else it is disabled and says why", () => {
    for (const role of ["owner", "admin", "member", "viewer", undefined]) {
      workspace.role = role;
      render(<ConnectorRenameButton slug="acme" onRenamed={onRenamed} />);
      const button = screen.getByRole("button", { name: "Rename…" });
      const allowed = canRenameConnector(role);
      expect([role, allowed]).toEqual([role, role !== "viewer" && !!role]);
      expect([role, button.hasAttribute("disabled")]).toEqual([role, !allowed]);
      // The reason is the tooltip of the disabled button.
      expect([
        role,
        screen.queryByLabelText(CONNECTOR_RENAME_REFUSAL) !== null,
      ]).toEqual([role, !allowed]);
      cleanup();
    }
  });
});
