import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import { studyApi } from "@/api/study";
import type { CalibrationDataPoint } from "@/api/types";
import { cn } from "@/utils/cn";

// ---- SVG scatter plot ------------------------------------------------

const W = 260;
const H = 180;
const PAD = { top: 12, right: 12, bottom: 36, left: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Map confidence (1-5) to x pixel. */
function cx(conf: number) {
  return PAD.left + ((conf - 1) / 4) * PLOT_W;
}
/** Map correctness (0/1) to y pixel — 1 (correct) at top. */
function cy(correct: boolean) {
  return PAD.top + (correct ? 0.1 : 0.9) * PLOT_H;
}

interface DotProps {
  point: CalibrationDataPoint;
}
function Dot({ point }: DotProps) {
  if (point.confidence === null || point.correct === null) return null;
  const x = cx(point.confidence);
  const y = cy(point.correct);
  return (
    <circle
      cx={x}
      cy={y}
      r={5}
      className={cn(
        "opacity-70 transition-opacity hover:opacity-100",
        point.correct
          ? "fill-emerald-500 stroke-emerald-700"
          : "fill-red-400 stroke-red-600"
      )}
      strokeWidth={1}
    >
      <title>
        {point.unit_title} · obj {point.objective_index} · confidence{" "}
        {point.confidence}/5 · {point.correct ? "correct ✓" : "incorrect ✗"} ·{" "}
        {point.phase}
      </title>
    </circle>
  );
}

// ---- Main component --------------------------------------------------

interface CalibrationChartProps {
  projectId: string;
}

export function CalibrationChart({ projectId }: CalibrationChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["study", "calibration", projectId],
    queryFn: () => studyApi.getCalibrationHistory(projectId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-xs text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  const points = data?.data_points ?? [];
  const withBoth = points.filter(
    (p) => p.confidence !== null && p.correct !== null
  );

  if (withBoth.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-[var(--text-muted)]">
        <TrendingUp className="h-6 w-6 opacity-30" />
        <p className="text-xs">
          Calibration data appears here after the tutor scores your first
          retrieval attempt. Each dot is one attempt — green is correct, red is
          incorrect.
        </p>
      </div>
    );
  }

  // Simple calibration score: % of dots where confidence matched correctness
  // (high conf + correct OR low conf + incorrect).
  const calibrated = withBoth.filter(
    (p) =>
      (p.confidence! >= 4 && p.correct === true) ||
      (p.confidence! <= 2 && p.correct === false)
  ).length;
  const calibrationPct = Math.round((calibrated / withBoth.length) * 100);

  const overconfident = withBoth.filter(
    (p) => p.confidence! >= 4 && p.correct === false
  ).length;
  const underconfident = withBoth.filter(
    (p) => p.confidence! <= 2 && p.correct === true
  ).length;

  return (
    <div className="space-y-3">
      {/* Chart */}
      <div className="overflow-x-auto">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="mx-auto block"
          role="img"
          aria-label="Confidence vs correctness scatter plot"
        >
          {/* Grid lines */}
          {[1, 2, 3, 4, 5].map((conf) => (
            <line
              key={conf}
              x1={cx(conf)}
              y1={PAD.top}
              x2={cx(conf)}
              y2={PAD.top + PLOT_H}
              stroke="currentColor"
              strokeOpacity={0.1}
              strokeWidth={1}
            />
          ))}
          {/* Axis labels — confidence (x) */}
          {[1, 2, 3, 4, 5].map((conf) => (
            <text
              key={conf}
              x={cx(conf)}
              y={H - 8}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              opacity={0.45}
            >
              {conf}
            </text>
          ))}
          {/* X axis title */}
          <text
            x={PAD.left + PLOT_W / 2}
            y={H - 1}
            textAnchor="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.45}
          >
            confidence (1–5)
          </text>
          {/* Y axis labels */}
          <text
            x={PAD.left - 6}
            y={cy(true)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.45}
          >
            ✓
          </text>
          <text
            x={PAD.left - 6}
            y={cy(false)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize={9}
            fill="currentColor"
            opacity={0.45}
          >
            ✗
          </text>
          {/* Dots */}
          {withBoth.map((p) => (
            <Dot key={p.attempt_id} point={p} />
          ))}
          {/* Ideal diagonal zone (top-right + bottom-left = well calibrated) */}
          <text
            x={cx(4.6)}
            y={cy(true) - 6}
            textAnchor="middle"
            fontSize={8}
            fill="currentColor"
            opacity={0.3}
          >
            ideal
          </text>
        </svg>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-2 text-center text-[10px]">
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
          <div className="text-base font-bold text-[var(--text)]">
            {calibrationPct}%
          </div>
          <div className="text-[var(--text-muted)]">well-calibrated</div>
        </div>
        <div className="rounded-md border border-amber-300/40 bg-amber-50/40 px-2 py-1.5 dark:bg-amber-900/10">
          <div className="text-base font-bold text-amber-600 dark:text-amber-400">
            {overconfident}
          </div>
          <div className="text-[var(--text-muted)]">overconfident</div>
        </div>
        <div className="rounded-md border border-blue-300/40 bg-blue-50/40 px-2 py-1.5 dark:bg-blue-900/10">
          <div className="text-base font-bold text-blue-600 dark:text-blue-400">
            {underconfident}
          </div>
          <div className="text-[var(--text-muted)]">underconfident</div>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
        Each dot is one retrieval attempt.{" "}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          Green = correct
        </span>
        ,{" "}
        <span className="font-medium text-red-500">red = incorrect</span>.
        Dots in the top-right and bottom-left are well-calibrated.
        Top-left (high confidence, wrong) is overconfidence.
      </p>
    </div>
  );
}
