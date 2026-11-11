// @vitest-environment jsdom
/**
 * The app Rename dialog: name and link are edited separately, a value the
 * server would refuse is refused as it is typed — in the server's own words
 * (@mako/schemas) — and the dialog says the old link keeps working.
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
      slugIsLink
      onClose={() => undefined}
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return {
    onConfirm,
    link: screen.getByLabelText("Link") as HTMLInputElement,
    name: screen.getByLabelText("Name") as HTMLInputElement,
    button: () =>
      screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement,
  };
};

describe("AppRenameDialog", () => {
  it("sends only what changed: the name, the link, or both", () => {
    const { onConfirm, link, name, button } = renderDialog();
    expect(button().disabled).toBe(true);
    fireEvent.change(name, { target: { value: " Weekly report " } });
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenLastCalledWith({ title: "Weekly report" });
    fireEvent.change(name, { target: { value: "Report" } });
    fireEvent.change(link, { target: { value: "revenue" } });
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onConfirm).toHaveBeenLastCalledWith({ slug: "revenue" });
    fireEvent.change(name, { target: { value: "Revenue" } });
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenLastCalledWith({
      title: "Revenue",
      slug: "revenue",
    });
  });

  it("says from the start that the old link keeps working, and previews the new one", () => {
    const { link } = renderDialog();
    expect(
      screen.getByText(
        "If you change the link, the old one (/apps/report) keeps working: it will still open this app.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("/apps/report")).toBeTruthy();
    // An NFD spelling is shown, and sent, as the NFC name the server stores.
    fireEvent.change(link, { target: { value: "café" } });
    expect(screen.getByText("/apps/café")).toBeTruthy();
    cleanup();
    // A nested or personal app's link uses its id: say so, promise the same.
    renderDialog({ slugIsLink: false });
    expect(screen.getByText(/link uses its id/)).toBeTruthy();
    expect(screen.getByText(/the old one keeps working/)).toBeTruthy();
  });

  it("locks the link with its reason and sends the name only", () => {
    const reason =
      "Only the owner of this personal folder can change the app's link.";
    const { onConfirm, link, name, button } = renderDialog({
      linkLockedReason: reason,
    });
    expect(link.disabled).toBe(true);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText("Only the name can change here.")).toBeTruthy();
    fireEvent.change(name, { target: { value: "Plan" } });
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenCalledWith({ title: "Plan" });
  });

  it.each([
    ["Search", '"Search" is reserved by Mako. Pick another link.'],
    [
      "CON",
      "\"CON\" can't be used on Windows, so it can't be a link. Pick another.",
    ],
    [
      "0123456789abcdef01234567",
      "This looks like an app id, so it can't be a link. Pick another.",
    ],
    ["x".repeat(101), "Keep the link to 100 characters or fewer."],
    ["report.", "A link can't end with a dot or a space."],
    [
      "a/b",
      "Use only letters, numbers, spaces, dots, dashes and underscores in a link.",
    ],
    ["-report", "Start the link with a letter or a number."],
    ["   ", "Give the app a link."],
  ])("refuses the link %j as it is typed, with Rename off", (typed, reason) => {
    const { onConfirm, link, button } = renderDialog();
    fireEvent.change(link, { target: { value: typed } });
    expect(screen.getByText(reason)).toBeTruthy();
    expect(button().disabled).toBe(true);
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ["​​", "The name cannot be empty."],
    [
      "Report\u0000",
      "The name cannot contain line breaks, tabs or other control characters.",
    ],
    ["x".repeat(1001), "The name is longer than 1000 characters."],
  ])("refuses the name %j as it is typed", (typed, reason) => {
    const { onConfirm, name, button } = renderDialog();
    fireEvent.change(name, { target: { value: typed } });
    expect(screen.getByText(reason)).toBeTruthy();
    expect(button().disabled).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    // Its own link in another case: the dialog knows the current link.
    [
      "Report",
      '"Report" differs from the current link only in upper and lower case, which macOS and Windows can\'t tell apart. Pick a different link.',
    ],
    // A link another app or folder beside it holds, as far as the lists say.
    ["revenue", "The link /apps/revenue is already taken. Pick another."],
    [
      "Sales",
      '"Sales" differs from "sales" only in upper and lower case, which macOS and Windows can\'t tell apart. Pick another link.',
    ],
  ])(
    "refuses the link %j without asking the server, in its words",
    (typed, reason) => {
      const { onConfirm, link, button } = renderDialog({
        takenNames: ["revenue", "sales"],
      });
      fireEvent.change(link, { target: { value: typed } });
      expect(screen.getByText(reason)).toBeTruthy();
      expect(button().disabled).toBe(true);
      fireEvent.keyDown(link, { key: "Enter" });
      expect(onConfirm).not.toHaveBeenCalled();
      // A free one is still fine.
      fireEvent.change(link, { target: { value: "income" } });
      expect(button().disabled).toBe(false);
    },
  );

  it("words a taken link for a nested app by its folder, not by /apps/<link>", () => {
    const { link } = renderDialog({ slugIsLink: false, takenNames: ["daily"] });
    fireEvent.change(link, { target: { value: "daily" } });
    expect(
      screen.getByText(
        '"daily" is already taken in this folder. Pick another link.',
      ),
    ).toBeTruthy();
  });

  it("drops the server's refusal as soon as a field is edited, and shows the next one", () => {
    const props = {
      open: true,
      currentTitle: "Report",
      currentSlug: "report",
      slugIsLink: true,
      onClose: () => undefined,
      onConfirm: () => undefined,
    };
    const { rerender } = render(
      <AppRenameDialog {...props} error="The link /apps/x is already taken." />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Link"), {
      target: { value: "y" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // The next attempt's refusal shows again (the explorer clears, then sets).
    rerender(<AppRenameDialog {...props} error={null} />);
    rerender(<AppRenameDialog {...props} error="This app was deleted." />);
    expect(screen.getByRole("alert").textContent).toBe("This app was deleted.");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Z" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not hold an unchanged link against a name change, and shows the server's refusal", () => {
    // An app pushed from a laptop as `search` may still be given a new name.
    const { onConfirm, name, button } = renderDialog({
      currentSlug: "search",
      error: "The link /apps/revenue is already taken. Pick another.",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "The link /apps/revenue is already taken. Pick another.",
    );
    fireEvent.change(name, { target: { value: "Search report" } });
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenCalledWith({ title: "Search report" });
  });
});
