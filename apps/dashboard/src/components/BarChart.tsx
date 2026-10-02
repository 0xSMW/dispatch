import { ChartFrame, scale, useHover, viewHeight, viewWidth, xs, type ChartProps } from "./chart";
import { Empty } from "./Empty";

/**
 * Bars per x value. Several series stack in order, such as transient, permanent, and
 * undetermined bounces. `threshold` draws a dashed risk line.
 */
export function BarChart({ series, threshold, format = String, formatX = (value) => value, label }: ChartProps) {
  const labels = xs(series);
  const hover = useHover(labels.length);
  if (labels.length === 0) return <Empty title="No data" body="Nothing happened in this range." />;

  const totals = labels.map((_, index) => series.reduce((sum, item) => sum + (item.points[index]?.y ?? 0), 0));
  const max = Math.max(threshold?.y ?? 0, ...totals);
  const y = scale(max);
  const slot = viewWidth / labels.length;
  const width = Math.max(1, slot * 0.6);
  const position = (index: number) => (index + 0.5) / labels.length;

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
      {labels.map((x, index) => {
        let base = viewHeight;
        return (
          <g key={x}>
            {series.map((item) => {
              const value = item.points[index]?.y ?? 0;
              if (value <= 0) return null;
              const height = viewHeight - y(value);
              base -= height;
              return (
                <rect
                  key={item.name}
                  className={`chartBar ${item.tone ?? "success"}`}
                  x={index * slot + (slot - width) / 2}
                  y={base}
                  width={width}
                  height={height}
                />
              );
            })}
          </g>
        );
      })}
    </ChartFrame>
  );
}
