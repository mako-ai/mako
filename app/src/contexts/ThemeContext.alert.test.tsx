// @vitest-environment jsdom
/**
 * Filled alerts in dark mode read white on the colour actually painted.
 *
 * MUI 7.1 paints a filled alert with `palette[color].dark` in dark mode but
 * chooses its text by contrast with `.main`, so the "new version available"
 * info toast came out black on mid-blue. The theme override in ThemeContext
 * picks the text against `.dark`; these tests pin the rendered colours.
 */
import { cleanup, render } from "@testing-library/react";
import { Alert, type AlertColor } from "@mui/material";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./ThemeContext";

const WHITE = "rgb(255, 255, 255)";
const BLACK_87 = "rgba(0, 0, 0, 0.87)";

function renderAlert(severity: AlertColor) {
  const { getByRole } = render(
    <ThemeProvider>
      <Alert severity={severity} variant="filled">
        A new version of Mako is available.
      </Alert>
    </ThemeProvider>,
  );
  const style = getComputedStyle(getByRole("alert"));
  return { color: style.color, background: style.backgroundColor };
}

function useMode(mode: "dark" | "light") {
  localStorage.setItem("themeMode", mode);
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("filled Alert text colour", () => {
  it.each([
    ["info", "rgb(2, 136, 209)"],
    ["success", "rgb(56, 142, 60)"],
  ] as const)(
    "dark mode %s: white on the dark shade it paints",
    (severity, bg) => {
      useMode("dark");
      expect(renderAlert(severity)).toEqual({ color: WHITE, background: bg });
    },
  );

  it("dark mode warning keeps dark text on orange", () => {
    useMode("dark");
    expect(renderAlert("warning").color).toBe(BLACK_87);
  });

  it("light mode is left to MUI", () => {
    useMode("light");
    expect(renderAlert("info").color).toBe(WHITE);
  });
});
