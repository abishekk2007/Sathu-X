"use client";

import Link from "next/link";
import {
  ArrowRightIcon,
  CalendarDaysIcon,
  ClockIcon,
  SparklesIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SESSION_TYPE_LABELS } from "@/components/planner/session-edit-dialog";
import { formatCountdownLabel } from "@/lib/study-planner";
import { formatMinutes } from "@/lib/utils";
import type { StudySessionRecord } from "@/types";

/**
 * Compact "study up next" strip rendered inside the student dashboard:
 * next exam countdown, today's first sessions and the AI recommendation.
 * All values come from the real study-dashboard payload.
 */
export function StudyUpNext({
  today,
  nextExam,
  recommendation,
  sessions,
  loading,
}: {
  today: string;
  nextExam: {
    title: string;
    daysLeft: number;
    subjectName?: string | null;
  } | null;
  recommendation: string | null;
  sessions: StudySessionRecord[];
  loading: boolean;
}) {
  const todays = sessions.filter((s) => s.scheduledDate === today);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDaysIcon className="size-4 text-primary" />
          Study up next
        </CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link href="/planner">
            Open planner
            <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="h-16 animate-pulse rounded-xl bg-muted/60" aria-hidden />
        ) : (
          <>
            {recommendation ? (
              <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                <SparklesIcon className="mr-1.5 inline size-3.5 text-primary" />
                {recommendation}
              </p>
            ) : null}

            {nextExam ? (
              <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium">
                  {nextExam.title}
                  {nextExam.subjectName ? (
                    <span className="text-muted-foreground"> · {nextExam.subjectName}</span>
                  ) : null}
                </span>
                <span className="ml-2 shrink-0 text-xs font-medium">
                  {formatCountdownLabel(nextExam.daysLeft)}
                </span>
              </div>
            ) : null}

            {todays.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No study sessions planned for today.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {todays.slice(0, 3).map((session) => (
                  <li key={session.id} className="flex items-center gap-2 text-sm">
                    <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {session.subjectName ?? session.topicName ?? "Study"}
                      <span className="text-muted-foreground">
                        {" · "}
                        {SESSION_TYPE_LABELS[session.sessionType ?? "study"] ??
                          session.sessionType}
                        {" · "}
                        {formatMinutes(session.durationMinutes)}
                        {session.status === "completed" ? " · done ✓" : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
