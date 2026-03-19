/**
 * Vega-Lite theme configuration that maps to MUI palette colors.
 * Produces a Vega-Lite Config object for light and dark modes.
 */

const CATEGORICAL_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ac",
];

interface ThemeColors {
  background: string;
  textPrimary: string;
  textSecondary: string;
  divider: string;
  surface: string;
}

const LIGHT: ThemeColors = {
  background: "#ffffff",
  textPrimary: "rgba(0, 0, 0, 0.87)",
  textSecondary: "rgba(0, 0, 0, 0.6)",
  divider: "rgba(0, 0, 0, 0.12)",
  surface: "#fafafa",
};

const DARK: ThemeColors = {
  background: "#1e1e1e",
  textPrimary: "#ffffff",
  textSecondary: "rgba(255, 255, 255, 0.7)",
  divider: "rgba(255, 255, 255, 0.12)",
  surface: "#121212",
};

export function getVegaThemeConfig(
  mode: "light" | "dark",
): Record<string, unknown> {
  const c = mode === "dark" ? DARK : LIGHT;

  return {
    background: c.background,
    padding: { left: 16, right: 16, top: 12, bottom: 12 },

    title: {
      color: c.textPrimary,
      subtitleColor: c.textSecondary,
      fontSize: 14,
      fontWeight: 600,
      subtitleFontSize: 12,
    },

    axis: {
      domainColor: c.divider,
      gridColor: c.divider,
      tickColor: c.divider,
      labelColor: c.textSecondary,
      titleColor: c.textPrimary,
      labelFontSize: 11,
      titleFontSize: 12,
      titlePadding: 8,
      labelPadding: 4,
    },

    legend: {
      labelColor: c.textSecondary,
      titleColor: c.textPrimary,
      labelFontSize: 11,
      titleFontSize: 12,
      symbolSize: 100,
    },

    view: {
      stroke: "transparent",
    },

    range: {
      category: CATEGORICAL_COLORS,
    },

    mark: {
      tooltip: true,
    },

    bar: {
      cornerRadiusEnd: 2,
    },

    line: {
      strokeWidth: 2,
    },

    point: {
      size: 60,
      filled: true,
    },

    arc: {
      stroke: c.background,
      strokeWidth: 1,
    },
  };
}
