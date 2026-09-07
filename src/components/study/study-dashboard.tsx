"use client";

import * as React from "react";
import {
  ArrowRightIcon,
  ClockIcon,
  FlameIcon,
  TargetIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { mockStudyTools } from "@/data/mock";
import { useStudyPlanner } from "@/hooks/use-study-planner";
import { formatStudyMinutes } from "@/lib/study-dashboard";
import { FlashcardDeck } from "@/components/study/flashcard-deck";
import { ToolDialog, toolIcons } from "@/components/study/tool-dialog";
import type { StudyTool } from "@/data/mock";

export function StudyDashboard() {
  const [activeTool, setActiveTool] = React.useState<StudyTool | null>(null);
  const { study, studyLoading, studyError, reloadStudy } = useStudyPlanner();
  const router = useRouter();

  const isLoading = studyLoading && !study;
  const hasError = !studyLoading && studyError !== null && !study;

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto scrollbar-slim">
        <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
          <PageHeader
            title="Study with SathuX"
            description="Turn your study material into understanding."
          />
          <section
            aria-label="Loading study tools"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-32 rounded-xl" />
            ))}
          </section>
          <section aria-label="Loading subjects" className="space-y-3">
            <Skeleton className="h-4 w-28" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1].map((row) => (
                <Skeleton key={row} className="h-32 rounded-xl" />
              ))}
            </div>
          </section>
          <section aria-label="Loading recent activity" className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <div className="space-y-2 rounded-2xl border bg-card p-2">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-11 rounded-xl" />
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <ErrorState
          title="Couldn't load your study dashboard."
          description="Check your connection and try again."
          onRetry={() => void reloadStudy()}
          className="max-w-md"
        />
      </div>
    );
  }

  const todayCompleted = study?.todayCompletedMinutes ?? 0;
  const dailyGoal = study?.dailyGoalMinutes ?? null;
  const goalLabel = dailyGoal !== null ? formatStudyMinutes(dailyGoal) : null;
  const goalProgress =
    dailyGoal !== null && dailyGoal > 0
      ? Math.min(100, Math.round((todayCompleted / dailyGoal) * 100))
      : 0;
  const subjects = study?.subjects ?? [];
  const activity = study?.recentActivity ?? [];

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          title="Study with SathuX"
          description="Turn your study material into understanding."
        />

        {/* Today's stats + tools */}
        <section
          aria-label="Study tools"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Card className="bg-gradient-to-br from-primary/12 to-indigo-500/10 ring-primary/25">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
                <FlameIcon className="size-4 text-primary" />
                Today&apos;s study
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">
                {formatStudyMinutes(todayCompleted)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {goalLabel !== null ? `Goal · ${goalLabel}` : "Set a daily goal to start tracking"}
              </p>
              {goalLabel !== null ? (
                <Progress
                  value={goalProgress}
                  className="mt-3 h-1.5"
                  aria-label={`Daily goal ${goalProgress} percent complete`}
                />
              ) : (
                <span className="mt-3 block h-1.5" />
              )}
            </CardContent>
          </Card>

          {mockStudyTools.slice(0, 3).map((tool) => (
            <ToolCard key={tool.id} tool={tool} onOpen={() => setActiveTool(tool)} />
          ))}
        </section>

        <section
          aria-label="More study tools"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {mockStudyTools.slice(3).map((tool) => (
            <ToolCard key={tool.id} tool={tool} onOpen={() => setActiveTool(tool)} />
          ))}
          <FlashcardDeck count={study?.flashcards ?? null} />
        </section>

        {/* Subjects */}
        <section aria-label="Subjects" className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Your subjects
          </h2>
          {subjects.length === 0 ? (
            <Card size="sm">
              <CardContent>
                <p className="text-sm font-medium">No subjects yet</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Add subjects in the student dashboard and SathuX will track
                  real progress and a next step for each.
                </p>
                <Button asChild size="sm" className="mt-3">
                  <Link href="/student">
                    Go to student dashboard
                    <ArrowRightIcon data-icon="inline-end" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {subjects.map((subject) => (
                <Card key={subject.id} size="sm">
                  <CardHeader>
                    <CardTitle>{subject.name}</CardTitle>
                    <p className="text-xs font-semibold text-primary">
                      {subject.progress}%
                    </p>
                  </CardHeader>
                  <CardContent>
                    <Progress
                      value={subject.progress}
                      className="h-1.5"
                      aria-label={`${subject.name} progress ${subject.progress} percent`}
                    />
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-muted-foreground">
                        {subject.nextTopic !== null
                          ? `Next: ${subject.nextTopic}`
                          : "No topics yet — add topics to track progress"}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => router.push("/chat")}
                          >
                            Continue
                            <ArrowRightIcon data-icon="inline-end" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Jump back in</TooltipContent>
                      </Tooltip>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Recent activity */}
        <section aria-label="Recent activity" className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Recent activity
          </h2>
          {activity.length === 0 ? (
            <Card size="sm">
              <CardContent>
                <p className="text-sm font-medium">No study activity yet</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Start a planner session or chat with SathuX in Student mode —
                  real study activity will appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <ul className="divide-y rounded-2xl border bg-card">
              {activity.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <TargetIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.action}
                    {item.subject ? (
                      <>
                        {" · "}
                        <span className="font-medium">{item.subject}</span>
                      </>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <ClockIcon className="size-3.5" />
                    {item.timeLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ToolDialog tool={activeTool} open={activeTool !== null} onOpenChange={(open) => !open && setActiveTool(null)} />
    </div>
  );
}

function ToolCard({ tool, onOpen }: { tool: StudyTool; onOpen: () => void }) {
  const Icon = toolIcons[tool.icon];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col justify-between rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-all hover:-translate-y-0.5 hover:ring-primary/40"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="size-4.5" />
      </span>
      <span className="mt-3 block font-medium">{tool.title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
        {tool.description}
      </span>
    </button>
  );
}