import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import {
  ThemeProvider as MuiThemeProvider,
  createTheme,
  alpha,
} from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "system";

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
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: "none",
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
            padding: theme.spacing(0.5, 1),
            color: theme.palette.text.secondary,
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
          root: {
            fontSize: 12,
          },
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
          const thumbColor = alpha(theme.palette.text.primary, 0.1);
          const thumbHoverColor = alpha(theme.palette.text.primary, 0.2);

          return {
            // Default (not hovered) state: thumb invisible but space reserved to avoid layout shift
            "*": {
              scrollbarColor: "transparent transparent",
              scrollbarWidth: "thin", // Keep width constant so layout doesn't move (Firefox)
            },
            // When the element itself is hovered, show colored thumb (Firefox uses same width)
            "*:hover": {
              scrollbarColor: `${thumbColor} transparent`,
            },
            "*::-webkit-scrollbar": {
              width: 8,
              height: 8,
            },
            "*::-webkit-scrollbar-track": {
              background: "transparent",
            },
            // Thumb hidden by default
            "*::-webkit-scrollbar-thumb": {
              borderRadius: 0,
              backgroundColor: "transparent",
              minHeight: 24,
            },
            // Thumb when container is hovered
            "*:hover::-webkit-scrollbar-thumb": {
              backgroundColor: thumbColor,
            },
            // Thumb when actively hovered/dragged
            "*:hover::-webkit-scrollbar-thumb:hover, *:hover::-webkit-scrollbar-thumb:active":
              {
                backgroundColor: thumbHoverColor,
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
          // Forward HTML input attributes to the underlying <input /> element
          inputProps: {
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
          },
          // For the new slot-based API (v5+)
          slotProps: {
            input: {
              autoComplete: "off",
              autoCorrect: "off",
              autoCapitalize: "off",
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 6, // Square with rounded corners instead of circular
          },
        },
      },
      MuiListItemText: {
        styleOverrides: {
          root: ({ theme, ownerState }: any) => ({
            ...(ownerState?.dense && {
              marginTop: theme.spacing(0.25),
              marginBottom: theme.spacing(0.25),
            }),
          }),
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
            padding: 2,
            fontSize: "2rem",
            borderRadius: 3,
            textTransform: "none",
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
