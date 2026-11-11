// @vitest-environment jsdom
/**
 * The dbt Rename dialog edits the FULL project path, says what is wrong
 * before anything is sent, keeps a server refusal on screen, and the
 * warnings of a rename stay until dismissed.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbtFileRenameDialog, DbtRenameWarnings } from "./DbtFileRenameDialog";

afterEach(cleanup);

const FROM = "models/marts/order_counts.sql";
const FILES = [FROM, "models/marts/fct_orders.sql"];

function renderDialog(
  onConfirm = vi.fn(async () => null as string | null),
  fromPath = FROM,
) {
  render(
    <DbtFileRenameDialog
      open
      fromPath={fromPath}
      existingPaths={FILES}
      onClose={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  const input = screen.getByLabelText(
    "Path in the dbt project",
  ) as HTMLInputElement;
  const button = screen.getByRole("button", {
    name: "Rename",
  }) as HTMLButtonElement;
  return { input, button, onConfirm };
}
const type = (input: HTMLInputElement, value: string) =>
  fireEvent.change(input, { target: { value } });

describe("DbtFileRenameDialog", () => {
  it("is prefilled with the full path, and sends the path typed from the project root", async () => {
    const { input, button, onConfirm } = renderDialog();
    expect(input.value).toBe(FROM);
    expect(button.disabled).toBe(true);
    type(input, "/dbt/models/staging/order_counts.sql");
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

  it("refuses a bad path as it is typed, in the server's words, and sends nothing", () => {
    const { input, button, onConfirm } = renderDialog();
    for (const [typed, said] of [
      ["../staging/x.sql", "The path must stay inside the dbt project."],
      ["models/marts/fct_orders.sql", "A file already exists there."],
      ["models/aux.sql", '"aux.sql" is a reserved name on Windows.'],
    ]) {
      type(input, typed);
      expect(screen.getByText(said)).toBeTruthy();
      expect(button.disabled).toBe(true);
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the server's refusal on screen until the path is edited", async () => {
    const said =
      "The dbt project changed while renaming. Reload and try again.";
    const { input, button } = renderDialog(vi.fn(async () => said));
    type(input, "models/marts/counts.sql");
    fireEvent.click(button);
    expect(await screen.findByText(said)).toBeTruthy();
    type(input, "models/marts/counts2.sql");
    expect(screen.queryByText(said)).toBeNull();
  });

  it("offers to update references for a model, on by default, and not for other files", async () => {
    const { input, button, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("checkbox"));
    type(input, "models/marts/counts.sql");
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith("models/marts/counts.sql", false),
    );
    cleanup();
    renderDialog(undefined, "models/schema.yml");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("DbtRenameWarnings", () => {
  it("shows each warning as a sentence with its detail, until dismissed", () => {
    const onClose = vi.fn();
    render(
      <DbtRenameWarnings
        warnings={[
          "Move that config or check the model.\nDetail: models.analytics.staging applied to it.",
          "The warehouse relation for 'orders' still exists until it is dropped.",
        ]}
        renamedTo="models/fct_orders.sql"
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText("Renamed to models/fct_orders.sql. Check these:"),
    ).toBeTruthy();
    expect(
      screen.getByText("Move that config or check the model."),
    ).toBeTruthy();
    expect(
      screen.getByText("Detail: models.analytics.staging applied to it."),
    ).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalled();
    cleanup();
    render(<DbtRenameWarnings warnings={[]} onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
