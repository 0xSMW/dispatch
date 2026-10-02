import { useState, type MouseEvent, type ReactNode } from "react";
import type { BadgeVariant } from "./Badge";

// Shared pieces for AreaChart and BarChart. Series colors use the badge tones, so a "bounced"
// series and a "bounced" badge are the same red.

export type Point = { x: string; y: number };

export type Series = {
  name: string;
  points: Point[];
  tone?: BadgeVariant;
};

export type Threshold = {
  y: number;
  label?: string;
};

export type ChartProps = {
  series: Series[];
  /** Dashed horizontal line, such as a 4% bounce-rate risk line. */
  threshold?: Threshold;
  /** Formats y values in the axis label and tooltip. */
  format?: (value: number) => string;
  /** Formats x values in the axis labels and tooltip. */
  formatX?: (value: string) => string;
  /** Accessible summary of the chart. */
  label: string;
};

export const viewWidth = 600;
export const viewHeight = 200;

export function xs(series: Series[]): string[] {
  const first = series.find((item) => item.points.length > 0);
  return first ? first.points.map((point) => point.x) : [];
}

export function scale(max: number) {
  const top = max <= 0 ? 1 : max * 1.1;
  return (value: number) => viewHeight - (value / top) * viewHeight;
}

export function useHover(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  return {
    index,
    onMouseMove(event: MouseEvent<HTMLElement>) {
      if (count === 0) return;
      const box = event.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
      setIndex(count === 1 ? 0 : Math.round(ratio * (count - 1)));
    },
    onMouseLeave() {
      setIndex(null);
    },
  };
}

export function ChartFrame({
  label,
  labels,
  max,
  format,
  formatX,
  hover,
  series,
  position,
  threshold,
  children,
}: {
  label: string;
  labels: string[];
  max: number;
  format: (value: number) => string;
  formatX: (value: string) => string;
  hover: ReturnType<typeof useHover>;
  series: Series[];
  /** Horizontal position of an index, 0 to 1. */
  position: (index: number) => number;
  /** Threshold line height in view units, with its label. */
  threshold?: { y: number; label?: string };
  children: ReactNode;
}) {
  const ticks = labels.length > 2 ? [0, Math.floor((labels.length - 1) / 2), labels.length - 1] : labels.map((_, index) => index);
  return (
    <figure className="chart" aria-label={label}>
      <div className="chartAxisY">{format(max)}</div>
      <div className="chartPlot" onMouseMove={hover.onMouseMove} onMouseLeave={hover.onMouseLeave}>
        <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} preserveAspectRatio="none" role="img" aria-label={label}>
          {children}
          {threshold ? (
            <line className="chartThreshold" x1={0} x2={viewWidth} y1={threshold.y} y2={threshold.y} vectorEffect="non-scaling-stroke" />
          ) : null}
          {hover.index !== null ? (
            <line
              className="chartGuide"
              x1={position(hover.index) * viewWidth}
              x2={position(hover.index) * viewWidth}
              y1={0}
              y2={viewHeight}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {threshold?.label ? (
          <span className="chartThresholdLabel" style={{ top: `${(threshold.y / viewHeight) * 100}%` }}>
            {threshold.label}
          </span>
        ) : null}
        {hover.index !== null && labels[hover.index] !== undefined ? (
          <div className={position(hover.index) > 0.6 ? "chartTooltip left" : "chartTooltip"} style={{ left: `${position(hover.index) * 100}%` }}>
            <strong>{formatX(labels[hover.index])}</strong>
            {series.map((item) => (
              <div key={item.name} className="chartTooltipRow">
                <span className={`swatch ${item.tone ?? "success"}`} />
                <span>{item.name}</span>
                <span className="mono">{format(item.points[hover.index!]?.y ?? 0)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="chartAxisX">
        {ticks.map((index) => (
          <span key={index}>{formatX(labels[index])}</span>
        ))}
      </div>
      {series.length > 1 ? (
        <figcaption className="chartLegend">
          {series.map((item) => (
            <span key={item.name}>
              <span className={`swatch ${item.tone ?? "success"}`} />
              {item.name}
            </span>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
