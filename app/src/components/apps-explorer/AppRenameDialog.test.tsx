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

  it("says a rename republishes the app only when it is published", () => {
    renderDialog();
    expect(screen.queryByText(/republishes/)).toBeNull();
    cleanup();
    renderDialog({ published: true });
    expect(screen.getByText(/republishes the app once/)).toBeTruthy();
    cleanup();
    renderDialog({ published: true, linkLockedReason: "Only ana can." });
    expect(
      screen.getByText(
        "Only the name can change here. A change rewrites mako.json, which republishes the app once.",
      ),
    ).toBeTruthy();
  });

  it("lets the link change when nothing locks it", () => {
    const { onConfirm, link } = renderDialog();
    expect(link.disabled).toBe(false);
    fireEvent.change(link, { target: { value: "report-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith({ slug: "report-2" });
  });

  it("says from the start that the old link keeps working", () => {
    renderDialog({ slugIsLink: true });
    expect(
      screen.getByText(
        "If you change the link, the old one (/apps/report) keeps working — it will still open this app.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("/apps/report")).toBeTruthy();
  });

  it.each([
    ["link", "This link is reserved by Mako — pick another."],
    ["Folders", "This link is reserved by Mako — pick another."],
    ["status-probe", "This link is reserved by Mako — pick another."],
    ["CON", "Not allowed on Windows: CON — pick another link."],
    ["nul.json", "Not allowed on Windows: nul.json — pick another link."],
    [
      "0123456789abcdef01234567",
      "This looks like an app id, so it can't be a link — pick another.",
    ],
    ["x".repeat(101), "Keep the link to 100 characters or fewer."],
    ["report.", "A link can't end with a dot or a space."],
    [
      "a/b",
      "Use only letters, numbers, spaces, dots, dashes and underscores in a link.",
    ],
    [
      "a:b",
      "Use only letters, numbers, spaces, dots, dashes and underscores in a link.",
    ],
    [
      "re\u200bport",
      "Use only letters, numbers, spaces, dots, dashes and underscores in a link.",
    ],
    ["-report", "Start the link with a letter or a number."],
    ["   ", "Give the app a link."],
  ])(
    "refuses the link %j as it is typed, in plain words, with Rename off",
    (typed, reason) => {
      const { onConfirm, link } = renderDialog({ slugIsLink: true });
      fireEvent.change(link, { target: { value: typed } });
      expect(screen.getByText(reason)).toBeTruthy();
      const button = screen.getByRole("button", {
        name: "Rename",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.keyDown(link, { key: "Enter" });
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it("accepts an NFD spelling and sends it as the NFC name the server stores", () => {
    const { onConfirm, link } = renderDialog({ slugIsLink: true });
    fireEvent.change(link, { target: { value: "cafe\u0301" } });
    expect(screen.getByText("/apps/café")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith({ slug: "café" });
  });

  it.each([
    ["\u200b\u200b", "An app needs a name."],
    [
      "Report\u0000",
      "A name can't contain line breaks, tabs or other control characters.",
    ],
    ["x".repeat(1001), "Keep the name to 1000 characters or fewer."],
  ])("refuses the name %j as it is typed", (typed, reason) => {
    const { onConfirm, name } = renderDialog();
    fireEvent.change(name, { target: { value: typed } });
    expect(screen.getByText(reason)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not hold an unchanged reserved link against a name change (an app pushed as `link` may still be renamed)", () => {
    const { onConfirm, name } = renderDialog({
      currentSlug: "link",
      slugIsLink: true,
    });
    fireEvent.change(name, { target: { value: "Links" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onConfirm).toHaveBeenCalledWith({ title: "Links" });
  });
});
