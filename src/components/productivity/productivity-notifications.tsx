import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckCircleIcon,
  FlameIcon,
  InfoIcon,
  ZapIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProductivityNotification } from "@/types";

const ICONS: Record<string, typeof InfoIcon> = {
  exam_approaching: AlertTriangleIcon,
  goal_behind: AlertTriangleIcon,
  streak_at_risk: FlameIcon,
  weak_topic: BookOpenIcon,
  session_due: CheckCircleIcon,
};

const SEVERITY_STYLES: Record<string, string> = {
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  urgent: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

export function ProductivityNotifications({
  notifications,
  loading,
}: {
  notifications: ProductivityNotification[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className="h-14 w-full animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  if (notifications.length === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <ZapIcon className="size-4 text-primary" />
          Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {notifications.map((n) => {
          const Icon = ICONS[n.kind] ?? InfoIcon;
          return (
            <div
              key={n.id}
              className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${SEVERITY_STYLES[n.severity] ?? SEVERITY_STYLES.info}`}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium">{n.title}</p>
                <p className="text-xs opacity-80">{n.body}</p>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
