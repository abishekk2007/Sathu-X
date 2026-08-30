import { MessageSquareIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChatStudyActivity } from "@/types";

/**
 * Displays recent academic chat study activity on the productivity dashboard.
 * Shows subjects and topics studied via chat with their active minutes.
 */
export function RecentChatStudy({
  activities,
  loading,
}: {
  activities: ChatStudyActivity[];
  loading: boolean;
}) {
  if (loading || activities.length === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageSquareIcon className="size-4 text-primary" />
          Chat study today
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {activities.map((activity, index) => (
          <div
            key={`${activity.subjectName}-${activity.topicName ?? "all"}-${index}`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="min-w-0 truncate">
              {activity.subjectName}
              {activity.topicName ? (
                <span className="text-muted-foreground">
                  {" \u2192 "}
                  {activity.topicName}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
              {activity.activeMinutes}m
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
