import { cn } from "@/lib/utils";
import { SpiderMark } from "@/components/branding/spider-mark";

export function SpideyLogo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        className={cn(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm shadow-violet-600/20",
          className
        )}
      >
        <SpiderMark className="size-5" />
      </span>
    );
  }

  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <SpideyLogo compact />
      <span className="text-[15px] leading-none font-semibold tracking-tight">
        SathuX
      </span>
    </span>
  );
}
