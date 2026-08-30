import { CheckCircleIcon, ClockIcon, MessageSquareIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function ProductivitySummary({
  todayCompletedMinutes,
  todayPlannedMinutes,
  weeklyMinutes,
  weeklyTarget,
  subjectsStudied,
  topicsPracticed,
  todayPlannerMinutes,
  todayChatMinutes,
  weeklyPlannerMinutes,
  weeklyChatMinutes,
  loading,
}: {
  todayCompletedMinutes: number;
  todayPlannedMinutes: number;
  weeklyMinutes: number;
  weeklyTarget: number | null;
  subjectsStudied: string[];
  topicsPracticed: string[];
  todayPlannerMinutes: number;
  todayChatMinutes: number;
  weeklyPlannerMinutes: number;
  weeklyChatMinutes: number;
  loading: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ClockIcon className="size-4 text-primary" />
          This week
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-5 w-32 animate-pulse rounded bg-muted" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5">
                <CheckCircleIcon className="size-4 text-emerald-500" />
                <span className="font-medium">{todayCompletedMinutes}m</span>
                <span className="text-muted-foreground">
                  / {todayPlannedMinutes}m today
                </span>
              </div>
            </div>

            {/* Source breakdown for today */}
            {(todayPlannerMinutes > 0 || todayChatMinutes > 0) && (
              <div className="flex gap-3 text-xs text-muted-foreground">
                {todayPlannerMinutes > 0 && (
                  <span className="flex items-center gap-1">
                    <ClockIcon className="size-3" />
                    Planner: {todayPlannerMinutes}m
                  </span>
                )}
                {todayChatMinutes > 0 && (
                  <span className="flex items-center gap-1">
                    <MessageSquareIcon className="size-3" />
                    Chat study: {todayChatMinutes}m
                  </span>
                )}
              </div>
            )}

            <div className="space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Weekly: {weeklyMinutes}m</span>
                {weeklyTarget !== null ? <span>Target: {weeklyTarget}m</span> : null}
              </div>
              {weeklyTarget !== null && weeklyTarget > 0 ? (
                <Progress
                  value={Math.min(100, Math.round((weeklyMinutes / weeklyTarget) * 100))}
                  className="h-1.5"
                  aria-label={`Weekly progress ${Math.round((weeklyMinutes / weeklyTarget) * 100)}%`}
                />
              ) : null}
              {/* Weekly source breakdown */}
              {(weeklyPlannerMinutes > 0 || weeklyChatMinutes > 0) && (
                <div className="flex gap-3 text-xs text-muted-foreground pt-0.5">
                  {weeklyPlannerMinutes > 0 && (
                    <span>Planner: {weeklyPlannerMinutes}m</span>
                  )}
                  {weeklyChatMinutes > 0 && (
                    <span>Chat: {weeklyChatMinutes}m</span>
                  )}
                </div>
              )}
            </div>
            {(subjectsStudied.length > 0 || topicsPracticed.length > 0) ? (
              <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                {subjectsStudied.length > 0 ? (
                  <span>{subjectsStudied.length} subject{subjectsStudied.length === 1 ? "" : "s"}</span>
                ) : null}
                {topicsPracticed.length > 0 ? (
                  <span>{topicsPracticed.length} topic{topicsPracticed.length === 1 ? "" : "s"} practised</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
