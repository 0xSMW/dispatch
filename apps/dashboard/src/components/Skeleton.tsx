export interface SkeletonProps {
  /** Number of bars. */
  lines?: number;
  width?: "short" | "medium" | "full";
  className?: string;
}

/** Gray bars that hold the place of content while it loads. */
export function Skeleton({ lines = 1, width = "full", className = "" }: SkeletonProps) {
  return (
    <span className={`skeletonGroup ${className}`.trim()} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className={`skeleton ${width}`} />
      ))}
    </span>
  );
}
