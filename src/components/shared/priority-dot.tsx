import type { TaskPriority } from "@/types";
import { cn } from "@/lib/utils";

const priorityConfig: Record<TaskPriority, { label: string; className: string }> = {
  high: { label: "High", className: "bg-red-500" },
  medium: { label: "Medium", className: "bg-amber-500" },
  low: { label: "Low", className: "bg-sky-500" },
};

export function PriorityDot({
  priority,
  showLabel = true,
  className,
}: {
  priority: TaskPriority;
  showLabel?: boolean;
  className?: string;
}) {
  const config = priorityConfig[priority];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", config.className)} />
      {showLabel ? config.label : <span className="sr-only">{config.label} priority</span>}
    </span>
  );
}
