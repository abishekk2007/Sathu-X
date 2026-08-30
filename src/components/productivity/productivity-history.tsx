import { HistoryIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProductivityDayRecord } from "@/types";

function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function scoreBar(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 60) return "bg-primary";
  if (score >= 40) return "bg-amber-500";
  if (score > 0) return "bg-rose-400";
  return "bg-muted";
}

export function ProductivityHistory({
  history,
  loading,
}: {
  history: ProductivityDayRecord[];
  loading: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <HistoryIcon className="size-4 text-primary" />
          Last 30 days
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-1.5" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-6 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No study activity yet.</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto scrollbar-slim">
            {history.map((day) => (
              <div
                key={day.date}
                className="flex items-center gap-2 text-sm"
              >
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {dayLabel(day.date)}
                </span>
                <div className="relative h-4 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${scoreBar(day.score)}`}
                    style={{ width: `${day.score}%` }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {day.completedMinutes}m
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
