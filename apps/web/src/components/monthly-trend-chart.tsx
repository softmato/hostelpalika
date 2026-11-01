"use client";

import Box from "@mui/material/Box";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { useMemo } from "react";

import { useDarkMode } from "@/lib/use-dark-mode";
import { LineChart, lineClasses } from "@mui/x-charts/LineChart";

export type TrendPoint = { collected: number; label: string; raised: number; views: number };

const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(value);

/**
 * Raised and collected share the left (money) axis; listing views get their
 * own on the right, since a view count would flatten a rupee line to nothing.
 */
export default function MonthlyTrendChart({ points }: { points: TrendPoint[] }) {
  const dark = useDarkMode();
  const theme = useMemo(() => createTheme({ palette: { mode: dark ? "dark" : "light" } }), [dark]);

  return (
    <ThemeProvider theme={theme}>
    <Box sx={{ height: 300, width: "100%" }}>
      <LineChart
        margin={{ right: 24 }}
        series={[
          { color: "#f59e0b", data: points.map((p) => p.raised), id: "raised", label: "Raised", showMark: true, valueFormatter: (v) => `NPR ${(v ?? 0).toLocaleString()}` },
          { color: "#0a8a4b", data: points.map((p) => p.collected), id: "collected", label: "Collected", showMark: true, valueFormatter: (v) => `NPR ${(v ?? 0).toLocaleString()}` },
          { color: "#6366f1", data: points.map((p) => p.views), id: "views", label: "Listing views", showMark: true, yAxisId: "views" },
        ]}
        sx={{
          [`.${lineClasses.line}, .${lineClasses.mark}`]: { strokeWidth: 1.5 },
          [`.${lineClasses.line}[data-series="raised"]`]: { strokeDasharray: "5 5" },
          [`.${lineClasses.line}[data-series="views"]`]: { strokeDasharray: "3 4 5 2" },
          [`.${lineClasses.mark}:not([data-highlighted="true"])`]: { fill: dark ? "#1c1c1c" : "#fff" },
          [`& [data-highlighted="true"]`]: { stroke: "none" },
        }}
        xAxis={[{ data: points.map((p) => p.label), height: 28, scaleType: "point" }]}
        yAxis={[
          { id: "money", valueFormatter: compact, width: 50 },
          { id: "views", position: "right", valueFormatter: compact, width: 40 },
        ]}
      />
    </Box>
    </ThemeProvider>
  );
}
