import { ArrowRightIcon, ClockIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { NextAction } from "@/types";

const ACTION_LABELS: Record<string, string> = {
  exam_prep: "Exam prep",
  complete_session: "Complete session",
  review_weak: "Review weak topic",
  goal_push: "Goal push",
  practice: "Practice",
  re_entry: "Get started",
};

export function NextActionCard({
  action,
  loading,
}: {
  action: NextAction | null;
  loading: boolean;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowRightIcon className="size-4 text-primary" />
          Next action
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            <div className="h-5 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : !action ? (
          <p className="text-sm text-muted-foreground">No pending actions — great job!</p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {ACTION_LABELS[action.actionType] ?? action.actionType}
              </span>
              {action.estimatedMinutes > 0 ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ClockIcon className="size-3" />
                  ~{action.estimatedMinutes}m
                </span>
              ) : null}
            </div>
            <p className="text-sm font-medium">{action.title}</p>
            <p className="text-xs text-muted-foreground">{action.reason}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
