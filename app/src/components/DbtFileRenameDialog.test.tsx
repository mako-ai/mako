// @vitest-environment jsdom
/**
 * The dbt Rename dialog edits the FULL project path, says what is wrong
 * before anything is sent, and keeps a server refusal on screen.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbtFileRenameDialog } from "./DbtFileRenameDialog";
import { DbtRenameWarnings } from "./DbtRenameWarnings";

afterEach(cleanup);

const FROM = "models/marts/order_counts.sql";
const FILES = [FROM, "models/staging/stg_orders.sql"];

function renderDialog(onConfirm = vi.fn(async () => null as string | null)) {
  render(
    <DbtFileRenameDialog
      open
      fromPath={FROM}
      existingPaths={FILES}
      onClose={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  const input = screen.getByLabelText(
    "Path in the dbt project",
  ) as HTMLInputElement;
  const button = screen.getByRole("button", { name: "Rename" });
  return { input, button, onConfirm };
}

describe("DbtFileRenameDialog", () => {
  it("is prefilled with the full path; Rename is off until it changes", () => {
    const { input, button } = renderDialog();
    expect(input.value).toBe(FROM);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the path typed from the project root, normalized", async () => {
    const { input, button, onConfirm } = renderDialog();
    fireEvent.change(input, {
      target: { value: "/models/staging/order_counts.sql" },
    });
    expect(
      screen.getByText("Will be saved as models/staging/order_counts.sql"),
    ).toBeTruthy();
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        "models/staging/order_counts.sql",
        true,
      ),
    );
  });

  it("says inline why a path cannot be used, and sends nothing", () => {
    const { input, button, onConfirm } = renderDialog();
    fireEvent.change(input, { target: { value: "../staging/x.sql" } });
    expect(
      screen.getByText("The path must stay inside the dbt project."),
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, {
      target: { value: "models/staging/stg_orders.sql" },
    });
    expect(screen.getByText("A file already exists there.")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps a server refusal on screen until the path is edited", async () => {
    const { input, button } = renderDialog(
      vi.fn(
        async () =>
          "The dbt project changed while renaming — reload and try again.",
      ),
    );
    fireEvent.change(input, { target: { value: "models/x.sql" } });
    fireEvent.click(button);
    expect(
      await screen.findByText(
        "The dbt project changed while renaming — reload and try again.",
      ),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "models/y.sql" } });
    expect(screen.queryByText(/changed while renaming/)).toBeNull();
  });
});

describe("DbtRenameWarnings", () => {
  it("stays until dismissed; plain sentence first, the precise key as detail", () => {
    const onClose = vi.fn();
    render(
      <DbtRenameWarnings
        warnings={[
          "dbt_project.yml config for models/marts (materialization, schema, tags…) no longer applies at its new place. Move that config or check the model.\nDetail: models.analytics.marts applied to models/marts/x.sql; it is now models/staging/x.sql.",
        ]}
        renamedTo="models/staging/x.sql"
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText("Renamed to models/staging/x.sql — check these"),
    ).toBeTruthy();
    expect(screen.getByText(/no longer applies at its new place/)).toBeTruthy();
    expect(
      screen.getByText(/models\.analytics\.marts applied to/),
    ).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("&gt;");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalled();
  });
});
