// @vitest-environment jsdom
/**
 * The rename dialog with its LINK locked (appRenameRights `title`): an
 * editor of an app in someone else's personal folder may change its name,
 * not its folder — the server would refuse the move. The link shows,
 * disabled, with the reason, and only the name is sent.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRenameDialog } from "./AppRenameDialog";

afterEach(cleanup);

const renderDialog = (
  props: Partial<Parameters<typeof AppRenameDialog>[0]> = {},
) => {
  const onConfirm = vi.fn();
  render(
    <AppRenameDialog
      open
      currentTitle="Report"
      currentSlug="report"
      slugIsLink={false}
      onClose={() => undefined}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  const link = screen.getByLabelText("Link") as HTMLInputElement;
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  return { onConfirm, link, name };
};

describe("AppRenameDialog", () => {
  it("locks the link with its reason and sends the name only", () => {
    const { onConfirm, link, name } = renderDialog({
      linkLockedReason: "Only ana@example.com can change this app's link.",
      // A typed folder name never gets through a locked link.
      prefillSlug: "report-2",
    });
    expect(link.disabled).toBe(true);
    expect(link.value).toBe("report");
    expect(
      screen.getByText("Only ana@example.com can change this app's link."),
    ).toBeTruthy();
    fireEvent.change(name, { target: { value: "Weekly report" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith({ title: "Weekly report" });
  });

  it("lets the link change when nothing locks it", () => {
    const { onConfirm, link } = renderDialog();
    expect(link.disabled).toBe(false);
    fireEvent.change(link, { target: { value: "report-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith({ slug: "report-2" });
  });
});
