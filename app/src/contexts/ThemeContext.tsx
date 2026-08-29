import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  ReactNode,
} from "react";
import {
  ThemeProvider as MuiThemeProvider,
  createTheme,
  alpha,
} from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "system";

const truncateTextStyles = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  effectiveMode: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/* eslint-disable react-refresh/only-export-components */
export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};

interface ThemeProviderProps {
  children: ReactNode;
}

// Function to detect system theme preference
const getSystemTheme = (): "light" | "dark" => {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
};

export const ThemeProvider: React.FC<ThemeProviderProps> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    // Get saved theme from localStorage or default to 'system'
    const savedMode = localStorage.getItem("themeMode") as ThemeMode;
    return savedMode || "system";
  });

  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(
    getSystemTheme,
  );

  // VS Code-style scrollbar reveal: the thumb also appears WHILE an element
  // is being scrolled (not only when the pointer happens to hover it), then
  // fades. CSS cannot express "is scrolling", so one capture-phase listener
  // tags the scrolling element and untags it shortly after the last event.
  // The CSS half lives in MuiCssBaseline below.
  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      el.setAttribute("data-scrolling", "");
      const prior = timers.get(el);
      if (prior) clearTimeout(prior);
      timers.set(
        el,
        setTimeout(() => el.removeAttribute("data-scrolling"), 800),
      );
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // Listen for system theme changes
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (e: MediaQueryListEvent) => {
        setSystemTheme(e.matches ? "dark" : "light");
      };

      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
  }, []);

  // Save theme preference to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem("themeMode", mode);
  }, [mode]);

  // Determine the effective theme mode
  const effectiveMode: "light" | "dark" =
    mode === "system" ? systemTheme : mode;

  // Sync the 'dark' class on <html> for Tailwind/Streamdown CSS variables.
  // useLayoutEffect keeps this aligned with MUI palette before paint (avoids
  // a frame where Streamdown/Tailwind still use light tokens after a toggle).
  useLayoutEffect(() => {
    if (effectiveMode === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [effectiveMode]);

  // Create theme based on effective mode
  const theme = createTheme({
    palette: {
      mode: effectiveMode,
      ...(effectiveMode === "light"
        ? {
            background: {
              default: "#fafafa",
              paper: "#ffffff",
            },
            primary: {
              main: "#1976d2",
            },
            secondary: {
              main: "#dc004e",
            },
          }
        : {
            background: {
              default: "#121212",
              paper: "#1e1e1e",
            },
            primary: {
              main: "#90caf9",
            },
            secondary: {
              main: "#f48fb1",
            },
          }),
    },
    typography: {
      fontFamily: [
        "-apple-system",
        "BlinkMacSystemFont",
        '"Segoe UI"',
        "Roboto",
        '"Helvetica Neue"',
        "Arial",
        "sans-serif",
      ].join(","),
      h1: {
        fontSize: "2rem",
        fontWeight: 700,
      },
      h2: {
        fontSize: "1.75rem",
        fontWeight: 600,
      },
      h3: {
        fontSize: "1.5rem",
        fontWeight: 500,
      },
      h4: {
        fontSize: "1.25rem",
        fontWeight: 400,
      },
      h5: {
        fontSize: "1rem",
        fontWeight: 300,
      },
      h6: {
        fontSize: "0.875rem",
        fontWeight: 600,
      },
      body1: {
        fontSize: "1rem",
      },
      body2: {
        fontSize: "0.825rem",
      },
    },
    components: {
      // ============ Dropdown/Popup styling (shadcn-like) ============
      // Apply subtle shadow and border to all dropdown-type components
      MuiMenu: {
        styleOverrides: {
          paper: ({ theme }: any) => ({
            boxShadow:
              "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 8,
            marginTop: 4,
          }),
          list: {
            padding: "4px",
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: ({ theme }: any) => ({
            boxShadow:
              "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 8,
          }),
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          paper: ({ theme }: any) => ({
            boxShadow:
              "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: 8,
            marginTop: 4,
          }),
          listbox: {
            padding: "4px",
          },
          option: ({ theme }: any) => ({
            fontSize: "0.8125rem",
            minHeight: 28,
            borderRadius: 4,
            margin: "1px 0",
            ...truncateTextStyles,
            '&[aria-selected="true"]': {
              backgroundColor: theme.palette.action.selected,
            },
            "&.Mui-focused": {
              backgroundColor: theme.palette.action.hover,
            },
            '&[aria-selected="true"].Mui-focused': {
              backgroundColor: theme.palette.action.selected,
            },
          }),
        },
      },
      MuiPopper: {
        styleOverrides: {
          root: {
            // Popper itself doesn't have paper, but this ensures consistent z-index
            zIndex: 1300,
          },
        },
      },
      // ============ End Dropdown/Popup styling ============

      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: "none",
            ...truncateTextStyles,
            maxWidth: "100%",
            "& .MuiButton-startIcon, & .MuiButton-endIcon": {
              flexShrink: 0,
            },
          },
          sizeSmall: {
            py: 1,
            px: 2,
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            transition: "background-color 0.2s ease, color 0.2s ease",
          },
        },
      },
      MuiSelect: {
        defaultProps: {
          size: "small",
          variant: "outlined",
        },
        styleOverrides: {
          root: ({ theme, ownerState }: any) => ({
            fontSize: "0.9em",
            borderRadius: 4,
            "& .MuiSelect-select": {
              fontSize: "0.9em",
              padding: theme.spacing(0.5, 1),
              display: "block",
              ...truncateTextStyles,
            },
            // Remove underline for the "standard" variant only (legacy)
            ...(ownerState.variant === "standard" && {
              "&:before, &:after": {
                display: "none",
              },
            }),
            transition: "background-color 0.2s ease, border-color 0.2s ease",
            "&:hover": {
              backgroundColor: theme.palette.action.hover,
            },
          }),
        },
      },
      MuiFormControl: {
        defaultProps: {
          variant: "outlined",
          margin: "normal",
          size: "small",
        },
      },
      MuiInputBase: {
        styleOverrides: {
          // Ensure font-size cascades to any InputBase that is part of a small Select
          root: ({ ownerState }) => ({
            ...(ownerState.size === "small" && {
              fontSize: "0.875rem",
              "@media (max-width:600px)": {
                fontSize: "16px",
              },
            }),
          }),
          input: {
            "@media (max-width:600px)": {
              fontSize: "16px",
            },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: {
            minHeight: 0,
            padding: 0,
          },
          scroller: {
            minHeight: 0,
          },
          indicator: {
            transition: "none",
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: ({ theme }: any) => ({
            textTransform: "none",
            minHeight: 0,
            maxWidth: "100%",
            padding: theme.spacing(0.5, 1),
            color: theme.palette.text.secondary,
            ...truncateTextStyles,
            // Larger touch target for tab strips on phones.
            "@media (max-width:600px)": {
              minHeight: 40,
            },
            "&:hover": {
              color: theme.palette.text.primary,
            },
            "&.Mui-selected": {
              backgroundColor: theme.palette.background.paper,
              color: theme.palette.text.primary,
            },
          }),
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: ({ theme }: any) => ({
            fontSize: "0.75rem",
            minHeight: 28,
            padding: "4px 8px",
            borderRadius: 4,
            margin: "1px 0",
            ...truncateTextStyles,
            "& .MuiListItemText-root": {
              minWidth: 0,
            },
            "&:hover": {
              backgroundColor: theme.palette.action.hover,
            },
            "&.Mui-selected": {
              backgroundColor: theme.palette.action.selected,
              "&:hover": {
                backgroundColor: theme.palette.action.selected,
              },
            },
            "&.Mui-focusVisible": {
              backgroundColor: theme.palette.action.focus,
            },
          }),
        },
      },
      MuiInputLabel: {
        defaultProps: {
          shrink: true,
        },
        styleOverrides: {
          root: ({ theme }: any) => ({
            transform: "none",
            position: "relative",
            top: 0,
            left: 0,
            marginBottom: 6,
            transition: "none",
            fontSize: "0.9rem",
            fontWeight: 500,
            color: theme.palette.text.primary,
            "&.MuiInputLabel-shrink": {
              transform: "none",
            },
          }),
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            ...truncateTextStyles,
          },
        },
      },
      MuiFormLabel: {
        styleOverrides: {
          root: ({ theme }: any) => ({
            transform: "none",
            position: "relative",
            top: 0,
            left: 0,
            marginBottom: 4,
            transition: "none",
            fontSize: "1rem",
            fontWeight: 600,
            color: theme.palette.text.primary,
            "&.MuiInputLabel-shrink, &.MuiFormLabel-filled": {
              transform: "none",
            },
          }),
        },
      },
      MuiOutlinedInput: {
        defaultProps: {
          size: "small",
        },
        styleOverrides: {
          root: {
            "& legend": {
              width: "0 !important",
            },
          },
        },
      },
      MuiCssBaseline: {
        styleOverrides: (theme: any) => {
          // VS Code's overlay scrollbar, as CSS: transparent track, a flat
          // square thumb that appears when you hover the container OR while
          // it is scrolling (data-scrolling, set by the listener in
          // ThemeProvider), and darkens under the pointer. Alphas match VS
          // Code's defaults (~0.25 resting, ~0.5 engaged) — the previous
          // 0.1 read as "the scrollbar is invisible".
          const thumbColor = alpha(theme.palette.text.primary, 0.24);
          const thumbHoverColor = alpha(theme.palette.text.primary, 0.5);

          return {
            // Default (not hovered) state: thumb invisible but space reserved to avoid layout shift
            "*": {
              scrollbarColor: "transparent transparent",
              scrollbarWidth: "thin", // Keep width constant so layout doesn't move (Firefox)
            },
            // When the element itself is hovered or scrolling, show the
            // thumb (Firefox uses the same width)
            "*:hover, *[data-scrolling]": {
              scrollbarColor: `${thumbColor} transparent`,
            },
            "*::-webkit-scrollbar": {
              width: 10,
              height: 10,
            },
            "*::-webkit-scrollbar-track": {
              background: "transparent",
            },
            "*::-webkit-scrollbar-corner": {
              background: "transparent",
            },
            // Thumb hidden by default
            "*::-webkit-scrollbar-thumb": {
              borderRadius: 0,
              backgroundColor: "transparent",
              minHeight: 24,
              backgroundClip: "padding-box",
              border: "2px solid transparent",
            },
            // Thumb when container is hovered or scrolling
            "*:hover::-webkit-scrollbar-thumb, *[data-scrolling]::-webkit-scrollbar-thumb":
              {
                backgroundColor: thumbColor,
              },
            // Thumb when actively hovered/dragged
            "*::-webkit-scrollbar-thumb:hover, *::-webkit-scrollbar-thumb:active":
              {
                backgroundColor: thumbHoverColor,
              },
            // OverlayScrollbars skin (VSScrollArea): the true zero-gutter
            // overlay used where content must reach the container's edge —
            // file trees, result tables. Same colors as the native thumbs
            // above so both kinds of scrollbar read as one design.
            ".os-theme-mako": {
              "--os-size": "10px",
              "--os-padding-perpendicular": "2px",
              "--os-padding-axis": "2px",
              "--os-track-border-radius": "0",
              "--os-handle-border-radius": "0",
              "--os-handle-bg": thumbColor,
              "--os-handle-bg-hover": thumbHoverColor,
              "--os-handle-bg-active": thumbHoverColor,
              "--os-handle-min-size": "24px",
              "--os-handle-interactive-area-offset": "4px",
            },
            // Link styling
            a: {
              color: theme.palette.primary.main,
              textDecoration: "none",
              transition: "color 0.2s ease, text-decoration 0.2s ease",
              "&:hover": {
                color:
                  theme.palette.mode === "dark"
                    ? theme.palette.primary.light
                    : theme.palette.primary.dark,
                textDecoration: "underline",
              },
              "&:active": {
                color: theme.palette.secondary.main,
              },
              "&:visited": {
                color:
                  theme.palette.mode === "dark"
                    ? alpha(theme.palette.primary.main, 0.8)
                    : alpha(theme.palette.primary.main, 0.7),
              },
            },
          };
        },
      },
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
      },
      MuiTextField: {
        defaultProps: {
          size: "small",
          autoComplete: "off",
          // Forward HTML input attributes to the underlying <input /> element.
          // NOTE: do NOT also set `slotProps.input` here. In MUI v7 a
          // `slotProps.input` (the modern replacement for `InputProps`) injected
          // via defaultProps takes precedence over and DISCARDS the legacy
          // `InputProps` that components like Autocomplete pass through
          // `renderInput` — which silently drops the Autocomplete end adornment
          // and its `anchorEl` ref, so the dropdown popup never mounts.
          inputProps: {
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 6, // Square with rounded corners instead of circular
            // Touch-friendly hit area on phones. Explicit per-component sizes
            // (e.g. compact 32px toolbar buttons) still win via `sx`.
            "@media (max-width:600px)": {
              minWidth: 40,
              minHeight: 40,
            },
          },
        },
      },
      MuiBottomNavigationAction: {
        styleOverrides: {
          root: ({ theme }: any) => ({
            minWidth: 0,
            paddingTop: theme.spacing(0.75),
            paddingBottom: theme.spacing(0.75),
            color: theme.palette.text.secondary,
            "&.Mui-selected": {
              color: theme.palette.primary.main,
            },
          }),
          label: {
            fontSize: "0.7rem",
            "&.Mui-selected": {
              fontSize: "0.7rem",
            },
          },
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          content: {
            minWidth: 0,
            overflow: "hidden",
          },
        },
      },
      MuiListItemText: {
        styleOverrides: {
          root: ({ theme, ownerState }: any) => ({
            minWidth: 0,
            ...(ownerState?.dense && {
              marginTop: theme.spacing(0.25),
              marginBottom: theme.spacing(0.25),
            }),
          }),
          primary: {
            display: "block",
            ...truncateTextStyles,
          },
          secondary: {
            display: "block",
            ...truncateTextStyles,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            maxWidth: "100%",
          },
          label: {
            display: "block",
            ...truncateTextStyles,
          },
        },
      },
      MuiToggleButtonGroup: {
        styleOverrides: {
          root: ({ theme }: any) => ({
            padding: 1, // 1px padding around the group
            borderRadius: 6,
            gap: 1,
            border: `1px solid ${theme.palette.divider}`,
          }),
          grouped: {
            border: 0,
            margin: 0,
            borderRadius: 4,
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            padding: "4px 10px",
            // Match button/body text. (Was mistakenly "2rem", which blew up
            // every text-based segmented control across the app.)
            fontSize: "0.8125rem",
            lineHeight: 1.4,
            borderRadius: 3,
            textTransform: "none",
            ...truncateTextStyles,
          },
        },
      },
    },
  });

  return (
    <ThemeContext.Provider value={{ mode, setMode, effectiveMode }}>
      <MuiThemeProvider theme={theme}>{children}</MuiThemeProvider>
    </ThemeContext.Provider>
  );
};
