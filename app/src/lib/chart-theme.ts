/**
 * Vega-Lite theme configuration that maps to MUI palette colors.
 * Produces a Vega-Lite Config object for light and dark modes.
 */

// Tailwind CSS default palette (v3 docs), mostly 500 shades for categorical charts.
const CATEGORICAL_COLORS = [
  // Keep the first colors maximally distinct for low-cardinality charts.
  "#0ea5e9", // sky-500
  "#f59e0b", // amber-500
  "#22c55e", // green-500
  "#ef4444", // red-500
  "#a855f7", // purple-500
  "#14b8a6", // teal-500
  "#f97316", // orange-500
  "#6366f1", // indigo-500
  "#84cc16", // lime-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#8b5cf6", // violet-500
  "#eab308", // yellow-500
  "#10b981", // emerald-500
  "#f43f5e", // rose-500
  "#3b82f6", // blue-500
  "#d946ef", // fuchsia-500
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
    padding: 10,

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
      // Used when no color encoding is provided (single-series defaults).
      color: CATEGORICAL_COLORS[0],
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

    text: {
      color: c.textPrimary,
    },

    arc: {
      stroke: c.background,
      strokeWidth: 1,
    },
  };
}
