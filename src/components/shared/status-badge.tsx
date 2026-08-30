import type { DocumentStatus } from "@/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig: Record<
  DocumentStatus,
  { label: string; dotClassName: string }
> = {
  uploaded: {
    label: "Uploaded",
    dotClassName: "bg-blue-500",
  },
  ready: {
    label: "Ready",
    dotClassName: "bg-emerald-500",
  },
  processing: {
    label: "Processing",
    dotClassName: "bg-amber-500 animate-pulse",
  },
  failed: {
    label: "Failed",
    dotClassName: "bg-red-500",
  },
  deleted: {
    label: "Deleted",
    dotClassName: "bg-red-400",
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: DocumentStatus;
  className?: string;
}) {
  const config = statusConfig[status];
  if (!config) return null;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal text-muted-foreground", className)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", config.dotClassName)}
      />
      {config.label}
    </Badge>
  );
}
