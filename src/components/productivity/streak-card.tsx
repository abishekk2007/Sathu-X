import { FlameIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProductivityStreak } from "@/types";

export function StreakCard({
  streak,
  loading,
}: {
  streak: ProductivityStreak | null;
  loading: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <FlameIcon className="size-4 text-primary" />
          Streak
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading || !streak ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-8 w-16 animate-pulse rounded bg-muted" />
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-2xl font-semibold tabular-nums">
              {streak.current}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}day{streak.current === 1 ? "" : "s"}
              </span>
            </p>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span>Best: {streak.longest}d</span>
              <span>This week: {streak.daysLast7}d</span>
              <span>This month: {streak.daysLast30}d</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
