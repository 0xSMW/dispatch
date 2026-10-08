import { Inbox } from "lucide-react";
import { ChartFrame, scale, useHover, viewHeight, viewWidth, xs, type ChartProps } from "./chart";
import { Empty } from "./Empty";

/**
 * Lines over shared x values. The first series is drawn as a filled area (delivered, in the
 * metrics page) and the rest as thin lines. Pass `{ x, y }[]` per series.
 */
export function AreaChart({ series, threshold, format = String, formatX = (value) => value, label }: ChartProps) {
  const labels = xs(series);
  const hover = useHover(labels.length);
  if (labels.length === 0) return <Empty title="No activity in this range" body="Try a longer date range." icon={<Inbox size={28} strokeWidth={1.5} />} />;

  const max = Math.max(threshold?.y ?? 0, ...series.flatMap((item) => item.points.map((point) => point.y)));
  const y = scale(max);
  const position = (index: number) => (labels.length === 1 ? 0.5 : index / (labels.length - 1));
  const line = (points: Array<{ y: number }>) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${(position(index) * viewWidth).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");

  return (
    <ChartFrame
      label={label}
      labels={labels}
      max={max}
      format={format}
      formatX={formatX}
      hover={hover}
      series={series}
      position={position}
      threshold={threshold ? { y: y(threshold.y), label: threshold.label } : undefined}
    >
      {series.map((item, index) => {
        const path = line(item.points);
        const tone = item.tone ?? "success";
        return (
          <g key={item.name}>
            {index === 0 ? (
              <path className={`chartArea ${tone}`} d={`${path} L${viewWidth},${viewHeight} L0,${viewHeight} Z`} />
            ) : null}
            <path className={`chartLine ${tone}`} d={path} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </ChartFrame>
  );
}
