"use client";

import * as React from "react";
import {
  CalendarDaysIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FlameIcon,
  ListTodoIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SkipForwardIcon,
  SparklesIcon,
  TargetIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { ExamFormDialog, EXAM_TYPE_LABELS } from "@/components/planner/exam-form-dialog";
import { GoalFormDialog } from "@/components/planner/goal-form-dialog";
import {
  PlanGenerateDialog,
} from "@/components/planner/plan-generate-dialog";
import {
  SessionEditDialog,
  SESSION_TYPE_LABELS,
} from "@/components/planner/session-edit-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { useStudyPlanner, type ExamInput, type GoalInput } from "@/hooks/use-study-planner";
import {
  addDaysIso,
  examDaysLeft,
  formatCountdownLabel,
  toDateOnly,
  weekStartIso,
} from "@/lib/study-planner";
import { cn, formatMinutes } from "@/lib/utils";
import type {
  ExamRecord,
  StudyGoalRecord,
  StudySessionRecord,
  SubjectRecord,
} from "@/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const PRIORITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Below avg",
  3: "Normal",
  4: "High",
  5: "Critical",
};

function todayIso(): string {
  return toDateOnly(new Date());
}

/** Minimal subjects loader — planner needs subject names for exam linking. */
function usePlannerSubjects() {
  const [subjects, setSubjects] = React.useState<SubjectRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/subjects?limit=100", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("request_failed");
      const data = (await response.json()) as { subjects?: SubjectRecord[] };
      setSubjects(data.subjects ?? []);
      setLoading(false);
    } catch {
      setError("unable_to_load");
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  return { subjects, loading, error, reload: load };
}

function urgencyBadgeVariant(band: string): "destructive" | "default" | "secondary" | "outline" {
  if (band === "critical") return "destructive";
  if (band === "high") return "default";
  if (band === "medium") return "secondary";
  return "outline";
}

function priorityBand(priority: number): string {
  if (priority >= 5) return "critical";
  if (priority >= 4) return "high";
  if (priority >= 3) return "medium";
  return "low";
}

function SkeletonRow() {
  return (
    <div className="h-16 animate-pulse rounded-xl bg-muted/60" aria-hidden />
  );
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

function ExamCard({
  exam,
  subjects,
  onEdit,
  onDelete,
  onStatus,
}: {
  exam: ExamRecord;
  subjects: SubjectRecord[];
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (status: string) => void;
}) {
  const daysLeft = examDaysLeft(exam.examDate, todayIso());
  const countdown =
    exam.status === "completed"
      ? "Exam completed"
      : formatCountdownLabel(daysLeft);

  const subjectName = exam.subjectName ?? subjects.find((s) => s.id === exam.subjectId)?.name ?? null;

  const dateLabel = new Date(`${exam.examDate.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words">{exam.title}</span>
          {exam.status === "upcoming" ? (
            <Badge variant={urgencyBadgeVariant(priorityBand(exam.priority))}>
              {PRIORITY_LABELS[exam.priority] ?? `P${exam.priority}`}
            </Badge>
          ) : null}
          {exam.status !== "upcoming" ? (
            <Badge variant="outline">{exam.status.replace("_", " ")}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{dateLabel}</span>
          <span
            className={cn(
              "font-medium",
              exam.status === "upcoming" &&
                daysLeft >= 0 &&
                daysLeft <= 3 &&
                "text-destructive"
            )}
          >
            {countdown}
          </span>
          {exam.examType ? <span>{EXAM_TYPE_LABELS[exam.examType] ?? exam.examType}</span> : null}
          {exam.targetScore != null ? <span>Target: {exam.targetScore}%</span> : null}
          <span>Priority {exam.priority}/5</span>
          {subjectName ? <span>{subjectName}</span> : null}
        </div>
        {exam.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{exam.description}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
          {exam.status === "upcoming" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onStatus("completed")}
              >
                <CheckCircle2Icon data-icon="inline-start" />
                Mark done
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onStatus("cancelled")}
              >
                Cancel
              </Button>
            </>
          ) : exam.status === "cancelled" || exam.status === "in_progress" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onStatus("upcoming")}
            >
              Reopen
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ExamsSection({
  exams,
  examsLoading,
  examsError,
  reloadExams,
  subjects,
  addExam,
  updateExam,
  deleteExam,
}: {
  exams: ExamRecord[];
  examsLoading: boolean;
  examsError: string | null;
  reloadExams: () => Promise<boolean | void>;
  subjects: SubjectRecord[];
  addExam: (input: ExamInput) => Promise<boolean>;
  updateExam: (
    id: string,
    patch: Partial<ExamInput> & { status?: string }
  ) => Promise<boolean>;
  deleteExam: (id: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = React.useState<ExamRecord | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const sorted = React.useMemo(() => {
    return [...exams].sort((a, b) =>
      a.examDate.localeCompare(b.examDate)
    );
  }, [exams]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          Add exam
        </Button>
      </div>

      {examsLoading ? (
        <div className="space-y-3">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : examsError ? (
        <ErrorState description="Could not load your exams." onRetry={() => void reloadExams()} />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={CalendarDaysIcon}
          title="No upcoming exams."
          description="Add your first exam so the study planner can prepare you for it."
          action={
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add exam
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sorted.map((exam) => (
            <ExamCard
              key={exam.id}
              exam={exam}
              subjects={subjects}
              onEdit={() => {
                setEditing(exam);
                setDialogOpen(true);
              }}
              onDelete={() => {
                if (window.confirm(`Delete "${exam.title}"? This cannot be undone.`)) {
                  void deleteExam(exam.id).then((ok) => {
                    if (ok) toast.success("Exam deleted");
                    else toast.error("Could not delete this exam.");
                  });
                }
              }}
              onStatus={(status) => {
                void updateExam(exam.id, { status }).then((ok) => {
                  if (!ok) toast.error("Could not update this exam.");
                });
              }}
            />
          ))}
        </div>
      )}

      <ExamFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        subjects={subjects}
        editing={editing}
        onSubmit={async (input) => {
          if (editing) {
            const ok = await updateExam(editing.id, input);
            if (ok) toast.success("Exam updated");
            return ok;
          }
          return addExam(input);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function SessionRow({
  session,
  onComplete,
  onSkip,
  onReopen,
  onEdit,
  onDelete,
}: {
  session: StudySessionRecord;
  onComplete: () => void;
  onSkip: () => void;
  onReopen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label =
    session.subjectName ?? session.topicName ?? null;
  const detail = [session.subjectName, session.topicName]
    .filter(Boolean)
    .join(" · ");

  const statusBadge =
    session.status === "completed" ? (
      <Badge variant="secondary">Completed</Badge>
    ) : session.status === "skipped" ? (
      <Badge variant="outline">Skipped</Badge>
    ) : session.status === "in_progress" ? (
      <Badge>In progress</Badge>
    ) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label ?? "Study session"}</span>
          {statusBadge}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {detail ? <span>{detail}</span> : null}
          <span className="inline-flex items-center gap-1">
            <ClockIcon className="size-3" />
            {formatMinutes(session.durationMinutes)}
          </span>
          <span>
            {SESSION_TYPE_LABELS[session.sessionType ?? "study"] ?? session.sessionType}
          </span>
          {session.startTime ? <span>{session.startTime.slice(0, 5)}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {session.status === "planned" || session.status === "in_progress" ? (
          <>
            <Button size="sm" variant="outline" onClick={onComplete}>
              <CheckCircle2Icon data-icon="inline-start" />
              Complete
            </Button>
            <Button size="sm" variant="ghost" onClick={onSkip}>
              <SkipForwardIcon data-icon="inline-start" />
              Skip
            </Button>
          </>
        ) : session.status === "completed" ? (
          <Button size="sm" variant="ghost" onClick={onReopen}>
            <Undo2Icon data-icon="inline-start" />
            Undo
          </Button>
        ) : session.status === "skipped" ? (
          <Button size="sm" variant="ghost" onClick={onReopen}>
            <Undo2Icon data-icon="inline-start" />
            Reschedule
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit session">
          <PencilIcon />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          aria-label="Delete session"
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

function SessionList({
  sessions,
  sessionsLoading,
  sessionsError,
  reloadSessions,
  emptyTitle,
  emptyDescription,
  onChangeStatus,
  onUpdateSession,
  onDeleteSession,
}: {
  sessions: StudySessionRecord[];
  sessionsLoading: boolean;
  sessionsError: string | null;
  reloadSessions: (window?: { from: string; to: string }) => Promise<boolean>;
  emptyTitle: string;
  emptyDescription: string;
  onChangeStatus: (id: string, status: "planned" | "completed" | "skipped") => void;
  onUpdateSession: (
    id: string,
    patch: Record<string, unknown>
  ) => Promise<boolean>;
  onDeleteSession: (id: string) => void;
}) {
  const [editing, setEditing] = React.useState<StudySessionRecord | null>(null);

  if (sessionsLoading) {
    return (
      <div className="space-y-3">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }
  if (sessionsError) {
    return (
      <ErrorState
        title="Couldn't load sessions."
        description="Please try again."
        onRetry={() => void reloadSessions()}
      />
    );
  }
  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={ListTodoIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <>
      <div className="space-y-2.5">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onComplete={() => onChangeStatus(session.id, "completed")}
            onSkip={() => onChangeStatus(session.id, "skipped")}
            onReopen={() => onChangeStatus(session.id, "planned")}
            onEdit={() => setEditing(session)}
            onDelete={() => onDeleteSession(session.id)}
          />
        ))}
      </div>

      <SessionEditDialog
        session={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSubmit={(id, input) => onUpdateSession(id, input)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly grid
// ---------------------------------------------------------------------------

const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday-first display order

function WeeklyGrid({
  weekFrom,
  today,
  onPrev,
  onThisWeek,
  onNext,
  onDaySessions,
}: {
  weekFrom: string;
  today: string;
  onPrev: () => void;
  onThisWeek: () => void;
  onNext: () => void;
  onDaySessions: (dayIso: string) => StudySessionRecord[];
}) {
  const rangeLabel = `${new Date(`${weekFrom}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${new Date(`${addDaysIso(weekFrom, 6)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon-sm" onClick={onPrev} aria-label="Previous week">
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" size="sm" onClick={onThisWeek}>
            This week
          </Button>
          <Button variant="outline" size="icon-sm" onClick={onNext} aria-label="Next week">
            <ChevronRightIcon />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{rangeLabel}</p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {WEEK_DAYS.map((dayIndex) => {
          const dayIso = addDaysIso(weekFrom, (dayIndex + 6) % 7);
          const daySessions = onDaySessions(dayIso);
          const totalMinutes = daySessions
            .filter((s) => s.status === "completed")
            .reduce((sum, s) => sum + s.durationMinutes, 0);
          const isToday = dayIso === today;

          return (
            <div
              key={dayIso}
              className={cn(
                "flex min-h-32 flex-col gap-2 rounded-xl border p-2.5",
                isToday && "border-primary/50 bg-primary/5"
              )}
            >
              <div className="flex items-center justify-between text-xs font-medium">
                <span className={cn(isToday && "text-primary")}>
                  {DAY_NAMES[dayIndex]}
                  {" "}
                  {dayIso.slice(8, 10)}
                </span>
                {totalMinutes > 0 ? (
                  <span className="text-muted-foreground">{formatMinutes(totalMinutes)}</span>
                ) : null}
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                {daySessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground/60">No sessions</p>
                ) : (
                  daySessions.slice(0, 4).map((session) => (
                    <div
                      key={session.id}
                      className={cn(
                        "rounded-lg border px-2 py-1.5 text-xs",
                        session.status === "completed" && "opacity-60"
                      )}
                      title={`${session.subjectName ?? ""} ${session.topicName ?? ""}`.trim()}
                    >
                      <p className="truncate font-medium">
                        {session.subjectName ?? session.topicName ?? "Study"}
                      </p>
                      <p className="truncate text-muted-foreground">
                        {SESSION_TYPE_LABELS[session.sessionType ?? "study"]} ·{" "}
                        {formatMinutes(session.durationMinutes)}
                        {session.startTime ? ` · ${session.startTime.slice(0, 5)}` : ""}
                        {session.status === "completed" ? " ✓" : ""}
                        {session.status === "skipped" ? " (skipped)" : ""}
                      </p>
                    </div>
                  ))
                )}
                {daySessions.length > 4 ? (
                  <p className="text-xs text-muted-foreground">
                    +{daySessions.length - 4} more
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function GoalCard({
  goal,
  onEdit,
  onDelete,
  onComplete,
}: {
  goal: StudyGoalRecord;
  onEdit: () => void;
  onDelete: () => void;
  onComplete: () => void;
}) {
  const completed =
    goal.progressMinutes ?? goal.completedMinutes ?? 0;
  const percent =
    goal.targetMinutes && goal.targetMinutes > 0
      ? Math.min(100, Math.round((completed / goal.targetMinutes) * 100))
      : null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="break-words">{goal.title}</span>
          <Badge variant={goal.status === "active" ? "default" : "outline"}>
            {goal.status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {goal.targetMinutes ? (
          <div className="space-y-1.5">
            <Progress value={percent ?? 0} />
            <p className="text-xs text-muted-foreground">
              {formatMinutes(completed)} of {formatMinutes(goal.targetMinutes)}
              {percent !== null ? ` · ${percent}%` : ""}
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{formatMinutes(completed)} logged</p>
        )}
        {goal.targetDate ? (
          <p className="text-xs text-muted-foreground">
            Target date: {goal.targetDate}
          </p>
        ) : null}
        {goal.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{goal.description}</p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
          {goal.status === "active" ? (
            <Button variant="ghost" size="sm" onClick={onComplete}>
              <CheckCircle2Icon data-icon="inline-start" />
              Complete
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function GoalsSection({
  goals,
  goalsLoading,
  goalsError,
  reloadGoals,
  addGoal,
  updateGoal,
  deleteGoal,
}: {
  goals: StudyGoalRecord[];
  goalsLoading: boolean;
  goalsError: string | null;
  reloadGoals: () => Promise<boolean | void>;
  addGoal: (input: GoalInput) => Promise<boolean>;
  updateGoal: (
    id: string,
    patch: Partial<GoalInput> & { status?: string }
  ) => Promise<boolean>;
  deleteGoal: (id: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = React.useState<StudyGoalRecord | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New goal
        </Button>
      </div>

      {goalsLoading ? (
        <div className="space-y-3">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : goalsError ? (
        <ErrorState description="Could not load your goals." onRetry={() => void reloadGoals()} />
      ) : goals.length === 0 ? (
        <EmptyState
          icon={TargetIcon}
          title="No study goals yet."
          description='Set a target like "Study 600 minutes this week" and track it from real completed sessions.'
          action={
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              New goal
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              onEdit={() => {
                setEditing(goal);
                setDialogOpen(true);
              }}
              onComplete={() => {
                void updateGoal(goal.id, { status: "completed" }).then((ok) => {
                  if (ok) toast.success("Goal completed");
                  else toast.error("Could not update this goal.");
                });
              }}
              onDelete={() => {
                if (window.confirm(`Delete goal "${goal.title}"?`)) {
                  void deleteGoal(goal.id).then((ok) => {
                    if (ok) toast.success("Goal deleted");
                    else toast.error("Could not delete this goal.");
                  });
                }
              }}
            />
          ))}
        </div>
      )}

      <GoalFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSubmit={async (input) => {
          if (editing) {
            const ok = await updateGoal(editing.id, input);
            if (ok) toast.success("Goal updated");
            return ok;
          }
          return addGoal(input);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function PlannerView() {
  const planner = useStudyPlanner();
  const subjectStore = usePlannerSubjects();
  const today = todayIso();

  const [tab, setTab] = React.useState("today");
  const [weekFrom, setWeekFrom] = React.useState(() => weekStartIso(today));
  const [generateOpen, setGenerateOpen] = React.useState(false);
  const [regeneratePlanId, setRegeneratePlanId] = React.useState<string | null>(null);

  // Honor deep links like /planner?tab=exams (read after mount so SSR and
  // client markup stay identical).
  React.useEffect(() => {
    queueMicrotask(() => {
      const requested = new URLSearchParams(window.location.search).get("tab");
      if (
        requested === "today" ||
        requested === "week" ||
        requested === "exams" ||
        requested === "goals"
      ) {
        setTab(requested);
      }
    });
  }, []);

  // Fetch exactly the visible week whenever navigation changes it.
  const weekWindow = React.useMemo(
    () => ({ from: weekFrom, to: addDaysIso(weekFrom, 6) }),
    [weekFrom]
  );

  const lastWindowRef = React.useRef<string>("");
  React.useEffect(() => {
    const key = `${weekWindow.from}:${weekWindow.to}`;
    if (lastWindowRef.current === key) return;
    lastWindowRef.current = key;
    queueMicrotask(() => {
      void planner.reloadSessions(weekWindow);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- planner methods are stable callbacks; window is the trigger
  }, [weekWindow.from, weekWindow.to]);

  const todaySessions = React.useMemo(() => {
    const list = planner.sessions.filter(
      (session) => session.scheduledDate === today
    );
    return [...list].sort((a, b) =>
      (a.startTime ?? "99:99").localeCompare(b.startTime ?? "99:99")
    );
  }, [planner.sessions, today]);

  const activePlan = planner.plans.find((plan) => plan.status === "active") ?? null;

  const handleGenerate = async (input: Record<string, unknown>) => {
    const result = await planner.generatePlan(
      input as unknown as Parameters<typeof planner.generatePlan>[0]
    );
    if (result.ok) {
      setGenerateOpen(false);
      setRegeneratePlanId(null);
      toast.success(
        result.source === "ai"
          ? "Study plan generated with AI."
          : "Study plan ready (built with the offline planner).",
        { description: `${result.sessions.length} sessions scheduled.` }
      );
      return true;
    }
    if (result.status === 400) {
      toast.error("Missing details.", {
        description: "Pick an upcoming exam and a valid date range.",
      });
    } else if (result.status === 409) {
      toast.error("Confirmation required to replace future sessions.");
    } else {
      toast.error("Could not generate a plan right now. Please try again.");
    }
    return false;
  };

  const stats = planner.study;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <PageHeader
        icon={CalendarDaysIcon}
        title="Study Planner"
        description="Exams, daily plans and goals — built around your weakest topics."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setRegeneratePlanId(null);
                setGenerateOpen(true);
              }}
            >
              <SparklesIcon data-icon="inline-start" />
              Generate plan
            </Button>
            {activePlan ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRegeneratePlanId(activePlan.id);
                  setGenerateOpen(true);
                }}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Regenerate
              </Button>
            ) : null}
          </>
        }
      />

      {/* Real-data stat strip */}
      {stats ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card size="sm">
            <CardContent className="flex items-center gap-3">
              <FlameIcon className="size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold">
                  {stats.streakDays > 0
                    ? `${stats.streakDays}-day streak`
                    : "No streak yet"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Complete a session today to keep it going.
                </p>
              </div>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex items-center gap-3">
              <ClockIcon className="size-5 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-semibold">
                  {formatMinutes(stats.week.completedMinutes)} studied this week
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatMinutes(stats.week.plannedMinutes)} planned ·{" "}
                  {stats.week.completionPercent}%
                </p>
              </div>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardContent className="flex items-center gap-3">
              <TargetIcon className="size-5 shrink-0 text-primary" />
              <div>
                <p className="truncate text-sm font-semibold">
                  {stats.nextExam
                    ? stats.nextExam.title
                    : "No upcoming exams."}
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats.nextExam
                    ? formatCountdownLabel(stats.nextExam.daysLeft)
                    : "Add one in the Exams tab."}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="week">Week</TabsTrigger>
          <TabsTrigger value="exams">Exams</TabsTrigger>
          <TabsTrigger value="goals">Goals</TabsTrigger>
        </TabsList>

        {/* ---- Today ---- */}
        <TabsContent value="today" className="space-y-4 pt-3">
          {planner.studyLoading ? (
            <div className="space-y-3">
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : planner.studyError ? (
            <ErrorState
              description="Could not load your study dashboard."
              onRetry={() => void planner.reloadStudy()}
            />
          ) : (
            <>
              {stats?.recommendation ? (
                <div className="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
                  <span className="font-medium">Spidey suggests: </span>
                  {stats.recommendation}
                </div>
              ) : null}

              <SessionList
                sessions={todaySessions}
                sessionsLoading={planner.sessionsLoading && planner.sessions.length === 0}
                sessionsError={planner.sessionsError}
                reloadSessions={planner.reloadSessions}
                emptyTitle="No study sessions planned."
                emptyDescription="Generate a plan or add sessions from the weekly view."
                onChangeStatus={(id, status) => {
                  void planner.changeSessionStatus(id, status).then((ok) => {
                    if (ok) {
                      toast.success(
                        status === "completed"
                          ? "Session completed — nice work!"
                          : status === "skipped"
                            ? "Session skipped."
                            : "Session reopened."
                      );
                    } else {
                      toast.error("Could not update this session.");
                    }
                  });
                }}
                onUpdateSession={async (id, patch) => {
                  const ok = await planner.updateSession(
                    id,
                    patch as Parameters<typeof planner.updateSession>[1]
                  );
                  if (!ok) toast.error("Could not update this session.");
                  return ok;
                }}
                onDeleteSession={(id) => {
                  if (window.confirm("Delete this session?")) {
                    void planner.deleteSession(id).then((ok) => {
                      if (ok) toast.success("Session deleted");
                      else toast.error("Could not delete this session.");
                    });
                  }
                }}
              />

              {activePlan ? (
                <Card size="sm">
                  <CardHeader>
                    <CardTitle className="text-sm">{activePlan.name || "Active study plan"}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {activePlan.startDate} → {activePlan.endDate}
                    </span>
                    <span>{formatMinutes(activePlan.dailyMinutes ?? 60)}/day target</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (window.confirm("Delete this plan and its unfinished future sessions?")) {
                          void planner.deletePlan(activePlan.id).then((ok) => {
                            if (ok) toast.success("Plan deleted");
                            else toast.error("Could not delete this plan.");
                          });
                        }
                      }}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      Delete plan
                    </Button>
                  </CardContent>
                </Card>
              ) : !planner.plansLoading && planner.plans.length === 0 ? (
                <EmptyState
                  icon={SparklesIcon}
                  title="Create your first study plan."
                  description="Pick an exam and your available time — Spidey schedules sessions around your weakest topics."
                  action={
                    <Button
                      size="sm"
                      onClick={() => {
                        setRegeneratePlanId(null);
                        setGenerateOpen(true);
                      }}
                    >
                      <SparklesIcon data-icon="inline-start" />
                      Generate plan
                    </Button>
                  }
                />
              ) : null}
            </>
          )}
        </TabsContent>

        {/* ---- Week ---- */}
        <TabsContent value="week" className="pt-3">
          <WeeklyGrid
            weekFrom={weekFrom}
            today={today}
            onPrev={() => setWeekFrom(addDaysIso(weekFrom, -7))}
            onNext={() => setWeekFrom(addDaysIso(weekFrom, 7))}
            onThisWeek={() => setWeekFrom(weekStartIso(today))}
            onDaySessions={(dayIso) =>
              planner.sessions.filter((s) => s.scheduledDate === dayIso)
            }
          />
        </TabsContent>

        {/* ---- Exams ---- */}
        <TabsContent value="exams" className="pt-3">
          <ExamsSection
            exams={planner.exams}
            examsLoading={planner.examsLoading}
            examsError={planner.examsError}
            reloadExams={planner.reloadExams}
            subjects={subjectStore.subjects}
            addExam={planner.addExam}
            updateExam={planner.updateExam}
            deleteExam={planner.deleteExam}
          />
        </TabsContent>

        {/* ---- Goals ---- */}
        <TabsContent value="goals" className="pt-3">
          <GoalsSection
            goals={planner.goals}
            goalsLoading={planner.goalsLoading}
            goalsError={planner.goalsError}
            reloadGoals={planner.reloadGoals}
            addGoal={planner.addGoal}
            updateGoal={planner.updateGoal}
            deleteGoal={planner.deleteGoal}
          />
        </TabsContent>
      </Tabs>

      <PlanGenerateDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        exams={planner.exams.filter(
          (exam) =>
            exam.status === "upcoming" ||
            new Date(`${exam.examDate.slice(0, 10)}T00:00:00`) >= new Date(`${today}T00:00:00`)
        )}
        regeneratePlanId={regeneratePlanId}
        onSubmit={handleGenerate}
      />
    </div>
  );
}
