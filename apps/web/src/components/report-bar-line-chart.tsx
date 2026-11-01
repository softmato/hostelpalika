"use client";

import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { BarChart } from "@mui/x-charts/BarChart";
import { type AnimatedLineProps, LineChart } from "@mui/x-charts/LineChart";
import { useMemo, useState } from "react";

import { useDarkMode } from "@/lib/use-dark-mode";

export type ReportPoint = { billed: number; collected: number; label: string };

type View = "bar" | "line";

/** A line that thickens under the pointer and dims when another series is picked. */
function HighlightLine(props: AnimatedLineProps) {
  const { className, d, ownerState, ...other } = props;
  // `skipAnimation` is MUI's own; it is not a DOM attribute.
  delete (other as { skipAnimation?: boolean }).skipAnimation;

  return (
    <>
      <path
        className={className}
        d={d}
        fill="none"
        filter={ownerState.isHighlighted ? "brightness(120%)" : undefined}
        opacity={ownerState.isFaded ? 0.3 : 1}
        stroke={ownerState.gradientId ? `url(#${ownerState.gradientId})` : ownerState.color}
        strokeLinejoin="round"
        strokeWidth={ownerState.isHighlighted ? 4 : 2}
      />
      {/* A wide invisible stroke, so a thin line is still easy to point at. */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={25} {...other} />
    </>
  );
}

const money = (value: number | null) => `NPR ${(value ?? 0).toLocaleString()}`;
const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(value);

/** Billed vs collected per month, as bars or lines; hovering highlights one and fades the rest. */
export default function ReportBarLineChart({ points }: { points: ReportPoint[] }) {
  const [view, setView] = useState<View>("bar");
  const dark = useDarkMode();
  const theme = useMemo(() => createTheme({ palette: { mode: dark ? "dark" : "light" } }), [dark]);

  const highlightScope = { fade: "global", highlight: "item" } as const;
  const series = [
    { color: "#f59e0b", data: points.map((p) => p.billed), highlightScope, id: "billed", label: "Billed", valueFormatter: money },
    { color: dark ? "#12a95d" : "#0a8a4b", data: points.map((p) => p.collected), highlightScope, id: "collected", label: "Collected", valueFormatter: money },
  ];
  const xAxis = [{ data: points.map((p) => p.label), height: 28, scaleType: "band" as const }];
  const yAxis = [{ valueFormatter: compact, width: 48 }];

  return (
    <ThemeProvider theme={theme}>
      <ToggleButtonGroup
        aria-label="chart type"
        exclusive
        onChange={(_, next: View | null) => next && setView(next)}
        size="small"
        value={view}
      >
        <ToggleButton value="bar">Bar</ToggleButton>
        <ToggleButton value="line">Line</ToggleButton>
      </ToggleButtonGroup>
      <Box sx={{ height: 300, width: "100%" }}>
        {view === "bar" ? (
          <BarChart series={series} xAxis={xAxis} yAxis={yAxis} />
        ) : (
          <LineChart
            series={series.map((item) => ({ ...item, showMark: true }))}
            slots={{ line: HighlightLine }}
            xAxis={[{ ...xAxis[0]!, scaleType: "point" as const }]}
            yAxis={yAxis}
          />
        )}
      </Box>
    </ThemeProvider>
  );
}
