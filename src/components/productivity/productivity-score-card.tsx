import { ZapIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { ProductivityScore } from "@/types";

function scoreColor(value: number): string {
  if (value >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (value >= 60) return "text-primary";
  if (value >= 40) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

export function ProductivityScoreCard({
  score,
  loading,
}: {
  score: ProductivityScore | null;
  loading: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ZapIcon className="size-4 text-primary" />
          Productivity score
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading || !score ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-8 w-20 animate-pulse rounded bg-muted" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
          </div>
        ) : (
          <>
            <p className={`text-2xl font-semibold tabular-nums ${scoreColor(score.value)}`}>
              {score.value}
              <span className="text-sm font-normal text-muted-foreground">/100</span>
            </p>
            <Progress value={score.value} className="h-1.5" aria-label={`Score ${score.value} out of 100`} />
            <p className="text-xs text-muted-foreground">
              {score.label} — {score.explanation}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
