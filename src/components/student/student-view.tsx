"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  BookOpenIcon,
  LightbulbIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TargetIcon,
  TrashIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { SubjectDetail } from "@/components/student/subject-detail";
import {
  SUBJECT_COLOR_STYLES,
  SubjectFormDialog,
} from "@/components/student/subject-form-dialog";
import { StudyUpNext } from "@/components/student/study-upnext";
import { TopicFormDialog } from "@/components/student/topic-form-dialog";
import { useProfile } from "@/hooks/use-profile";
import { useStudent } from "@/hooks/use-student";
import { buildPersonalizedGreeting } from "@/lib/student-productivity";
import { toDateOnly } from "@/lib/study-planner";
import type {
  ProductivityNotification,
  StudentDashboardData,
  StudyDashboardData,
  SubjectRecord,
} from "@/types";
import { cn, formatReviewedLabel } from "@/lib/utils";

export function StudentView() {
  const student = useStudent();
  const { profile } = useProfile();
  const searchParams = useSearchParams();

  // URL-authoritative subject selection (?s=<id>), mirroring the chat ?c= pattern.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    const requested = searchParams.get("s");
    queueMicrotask(() => {
      setSelectedId((current) => {
        const next =
          requested && student.subjects.some((s) => s.id === requested)
            ? requested
            : null;
        return next === current ? current : next;
      });
    });
  }, [searchParams, student.subjects]);

  const openSubject = (id: string) => {
    setSelectedId(id);
    window.history.replaceState(null, "", `/student?s=${encodeURIComponent(id)}`);
  };

  const closeSubject = () => {
    setSelectedId(null);
    window.history.replaceState(null, "", "/student");
  };

  // ---- Topic loading for the selected subject ------------------------------
  const [topicsLoading, setTopicsLoading] = React.useState(false);
  const [topicsError, setTopicsError] = React.useState(false);
  const { loadTopics } = student;

  React.useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTopicsLoading(true);
      setTopicsError(false);
      void loadTopics(selectedId).then((result) => {
        if (cancelled) return;
        setTopicsLoading(false);
        setTopicsError(result === null);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, loadTopics]);

  // ---- Dialogs ------------------------------------------------------------
  const [subjectDialogOpen, setSubjectDialogOpen] = React.useState(false);
  const [editingSubject, setEditingSubject] = React.useState<SubjectRecord | null>(
    null
  );
  const [topicDialogOpen, setTopicDialogOpen] = React.useState(false);

  const [search, setSearch] = React.useState("");
  const filteredSubjects = student.subjects.filter((subject) =>
    subject.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  // Topic counts + average mastery per subject, from the dashboard aggregate.
  const statsBySubject = React.useMemo(() => {
    const map: Record<
      string,
      { topicCount: number; avgMastery: number | null }
    > = {};
    for (const card of student.dashboard?.subjects ?? []) {
      map[card.id] = {
        topicCount: card.topicCount,
        avgMastery: card.avgMastery,
      };
    }
    return map;
  }, [student.dashboard]);

  const selectedSubject =
    student.subjects.find((s) => s.id === selectedId) ?? null;

  const handlePractice = (
    topic: { id: string; subjectId: string },
    correct: boolean
  ) => {
    void student.recordPractice(topic, correct).then((result) => {
      if (!result.ok) {
        toast.error("Could not record that practice result.");
        return;
      }
      toast.success(
        correct
          ? `Nice — confidence ${result.knowledge.confidenceScore}% · mastery ${result.topicMastery}%`
          : `Noted — review scheduled · mastery ${result.topicMastery}%`
      );
    });
  };

  const handleDeleteSubject = (subject: SubjectRecord) => {
    if (
      !window.confirm(
        `Delete "${subject.name}"? Its topics and practice history will be removed too.`
      )
    ) {
      return;
    }
    void student.deleteSubject(subject.id).then((ok) => {
      if (ok) {
        if (selectedId === subject.id) closeSubject();
        toast.success("Subject deleted");
      } else {
        toast.error("Could not delete the subject.");
      }
    });
  };

  // ---- Dashboard states -----------------------------------------------------
  const showDashboardSkeleton = student.dashboardLoading && !student.dashboard;
  const showDashboardError =
    !showDashboardSkeleton && !!student.dashboardError && !student.dashboard;

  // ---- Study planner strip (Phase 4C) ---------------------------------------
  // Single bounded request; failures just leave the strip empty.
  const [studyData, setStudyData] = React.useState<StudyDashboardData | null>(
    null
  );
  const [studyLoading, setStudyLoading] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/student/study-dashboard?today=${toDateOnly(new Date())}`,
            { headers: { Accept: "application/json" } }
          );
          if (!response.ok) throw new Error("request_failed");
          const data = (await response.json()) as StudyDashboardData;
          if (!cancelled) {
            setStudyData(data);
            setStudyLoading(false);
          }
        } catch {
          if (!cancelled) setStudyLoading(false);
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Productivity notifications (Phase 4D) --------------------------------
  const [productivityNotifications, setProductivityNotifications] = React.useState<
    ProductivityNotification[]
  >([]);
  React.useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/student/productivity?today=${toDateOnly(new Date())}`,
            { headers: { Accept: "application/json" } }
          );
          if (!response.ok) return;
          const data = (await response.json()) as { notifications: ProductivityNotification[] };
          if (!cancelled) setProductivityNotifications(data.notifications ?? []);
        } catch {
          // Fail-open — notifications are non-critical.
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const firstName = profile?.fullName?.split(/\s+/)[0] ?? null;
  const personalizedGreeting = buildPersonalizedGreeting({
    firstName,
    todayCompletedMinutes:
      studyData?.todaySessions
        ?.filter((s) => s.status === "completed")
        .reduce((sum, s) => sum + s.durationMinutes, 0) ?? 0,
    todayPlannedMinutes:
      studyData?.todaySessions?.reduce((sum, s) => sum + s.durationMinutes, 0) ?? 0,
    nextExam: studyData?.nextExam
      ? { title: studyData.nextExam.title, daysLeft: studyData.nextExam.daysLeft, subjectName: studyData.nextExam.subjectName }
      : null,
    weakestTopic: null,
  });

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={BookOpenIcon}
          title={personalizedGreeting.greeting}
          description={personalizedGreeting.subtitle ?? "Your academic overview — subjects, topics and progress."}
          actions={
            <Button
              size="sm"
              onClick={() => {
                setEditingSubject(null);
                setSubjectDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              Add subject
            </Button>
          }
        />

        {/* ---- Overview stats ---- */}
        {showDashboardSkeleton ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <Skeleton key={row} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : showDashboardError ? (
          <ErrorState
            title="Couldn't load your academic overview."
            description="Check your connection and try again."
            onRetry={() => void student.reloadDashboard()}
          />
        ) : student.dashboard ? (
          <StatsGrid data={student.dashboard} />
        ) : null}

        {/* ---- Study up next (planner integration) ---- */}
        <StudyUpNext
          today={studyData?.today ?? toDateOnly(new Date())}
          nextExam={
            studyData?.nextExam
              ? {
                  title: studyData.nextExam.title,
                  daysLeft: studyData.nextExam.daysLeft,
                  subjectName: studyData.nextExam.subjectName,
                }
              : null
          }
          recommendation={studyData?.recommendation ?? null}
          sessions={studyData?.todaySessions ?? []}
          loading={studyLoading}
        />

        {/* ---- Productivity notifications (Phase 4D) ---- */}
        {productivityNotifications.length > 0 ? (
          <Card size="sm">
            <CardContent className="space-y-2 pt-0">
              {productivityNotifications.map((n) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                    n.severity === "urgent"
                      ? "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                      : n.severity === "warning"
                        ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-medium">{n.title}</p>
                    <p className="text-xs opacity-80">{n.body}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {/* ---- Insights ---- */}
        {student.dashboard && student.dashboard.insights.length > 0 ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
                <LightbulbIcon className="size-4 text-primary" />
                Spidey insights
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {student.dashboard.insights.map((insight) => (
                <p key={insight} className="text-sm">
                  {insight}
                </p>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {/* ---- Weak / strong / recent ---- */}
        {student.dashboard ? (
          <HighlightsSection data={student.dashboard} />
        ) : null}

        {/* ---- Subject detail OR subjects grid ---- */}
        {selectedSubject ? (
          <section aria-label="Subject details">
            <SubjectDetail
              subject={selectedSubject}
              topics={student.topicsBySubject[selectedSubject.id] ?? []}
              topicsLoading={topicsLoading}
              topicsError={topicsError}
              onBack={closeSubject}
              onReloadTopics={() => void student.loadTopics(selectedSubject.id)}
              onEditSubject={() => {
                setEditingSubject(selectedSubject);
                setSubjectDialogOpen(true);
              }}
              onUpdateTopic={async (topic, patch) =>
                student.updateTopic(topic, patch)
              }
              onDeleteTopic={(topic) => {
                void student.deleteTopic(topic).then((ok) => {
                  if (ok) toast.success("Topic deleted");
                  else toast.error("Could not delete the topic.");
                });
              }}
              onDeleteSubject={() => handleDeleteSubject(selectedSubject)}
              onAddTopic={() => setTopicDialogOpen(true)}
              onPractice={handlePractice}
            />
          </section>
        ) : (
          <SubjectsSection
            subjects={filteredSubjects}
            totalCount={student.subjects.length}
            statsBySubject={statsBySubject}
            loading={student.subjectsLoading}
            error={student.subjectsError}
            search={search}
            onSearch={setSearch}
            onRetry={() => void student.reloadSubjects()}
            onOpen={openSubject}
            onEdit={(subject) => {
              setEditingSubject(subject);
              setSubjectDialogOpen(true);
            }}
            onDelete={handleDeleteSubject}
            onAdd={() => {
              setEditingSubject(null);
              setSubjectDialogOpen(true);
            }}
          />
        )}
      </div>

      {/* ---- Dialogs ---- */}
      <SubjectFormDialog
        open={subjectDialogOpen}
        onOpenChange={setSubjectDialogOpen}
        subject={editingSubject}
        onSubmit={async (input) =>
          editingSubject
            ? student.updateSubject(editingSubject.id, input)
            : student.addSubject(input)
        }
      />

      {selectedSubject ? (
        <TopicFormDialog
          open={topicDialogOpen}
          onOpenChange={setTopicDialogOpen}
          topicName={selectedSubject.name}
          onSubmit={async (input) => {
            const result = await student.addTopic(selectedSubject.id, input);
            if (!result.ok) {
              toast.error(
                result.conflict
                  ? "That topic already exists in this subject."
                  : "Could not add the topic. Please try again."
              );
            }
            return result.ok;
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview stats
// ---------------------------------------------------------------------------

function StatsGrid({ data }: { data: StudentDashboardData }) {
  const { stats } = data;
  const cells = [
    { label: "Subjects", value: String(stats.subjects) },
    { label: "Topics", value: String(stats.topics) },
    {
      label: "Overall mastery",
      value: stats.overallMastery === null ? "—" : `${stats.overallMastery}%`,
    },
    { label: "Strong topics", value: String(stats.strongTopics) },
    { label: "Needs review", value: String(stats.needsReviewTopics) },
    { label: "Weak topics", value: String(stats.weakTopics) },
  ];

  return (
    <section
      aria-label="Academic overview"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      {cells.map((cell) => (
        <Card key={cell.label} size="sm">
          <CardHeader>
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {cell.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tracking-tight tabular-nums">
              {cell.value}
            </p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Weak areas / strong areas / recent activity
// ---------------------------------------------------------------------------

function HighlightsSection({ data }: { data: StudentDashboardData }) {
  const { weakAreas, strongAreas, recentActivity } = data;
  if (
    weakAreas.length === 0 &&
    strongAreas.length === 0 &&
    recentActivity.length === 0
  ) {
    return null;
  }

  return (
    <section
      aria-label="Weak and strong areas"
      className="grid grid-cols-1 gap-3 md:grid-cols-3"
    >
      <HighlightCard
        icon={<TrendingDownIcon className="size-4 text-rose-500" />}
        title="Weak areas"
        emptyLabel="No weak areas right now."
        items={weakAreas.map((area) => ({
          id: area.topicId,
          name: area.topicName,
          detail: area.subjectName,
          value: `${area.mastery}%`,
        }))}
      />
      <HighlightCard
        icon={<TrendingUpIcon className="size-4 text-emerald-500" />}
        title="Strong areas"
        emptyLabel="Nothing above 60% yet — keep going!"
        items={strongAreas.map((area) => ({
          id: area.topicId,
          name: area.topicName,
          detail: area.subjectName,
          value: `${area.mastery}%`,
        }))}
      />
      <HighlightCard
        icon={<TargetIcon className="size-4 text-primary" />}
        title="Recent activity"
        emptyLabel="Practice a topic to see it here."
        items={recentActivity.map((activity) => ({
          id: `${activity.topicName}-${activity.reviewedAt}`,
          name: activity.topicName,
          detail: activity.subjectName ?? "",
          value:
            formatReviewedLabel(activity.reviewedAt).replace("reviewed ", "") ||
            "recently",
        }))}
      />
    </section>
  );
}

function HighlightCard({
  icon,
  title,
  items,
  emptyLabel,
}: {
  icon: React.ReactNode;
  title: string;
  items: Array<{ id: string; name: string; detail: string; value: string }>;
  emptyLabel: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          items.slice(0, 5).map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="min-w-0 truncate">
                {item.name}
                {item.detail ? (
                  <span className="text-muted-foreground"> · {item.detail}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                {item.value}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Subjects grid (list view)
// ---------------------------------------------------------------------------

function SubjectsSection({
  subjects,
  totalCount,
  statsBySubject,
  loading,
  error,
  search,
  onSearch,
  onRetry,
  onOpen,
  onEdit,
  onDelete,
  onAdd,
}: {
  subjects: SubjectRecord[];
  totalCount: number;
  statsBySubject: Record<string, { topicCount: number; avgMastery: number | null }>;
  loading: boolean;
  error: string | null;
  search: string;
  onSearch: (value: string) => void;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onEdit: (subject: SubjectRecord) => void;
  onDelete: (subject: SubjectRecord) => void;
  onAdd: () => void;
}) {
  return (
    <section aria-label="My subjects" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
          My subjects{totalCount > 0 ? ` (${totalCount})` : ""}
        </h2>
        {totalCount > 3 ? (
          <div className="relative w-full max-w-xs sm:w-auto">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search subjects…"
              className="h-8 pl-8 text-sm"
              aria-label="Search subjects"
            />
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorState
          title="Couldn't load your subjects."
          description="Check your connection and try again."
          onRetry={onRetry}
        />
      ) : totalCount === 0 ? (
        <EmptyState
          icon={BookOpenIcon}
          title="No subjects yet."
          description="Add your first subject to start tracking topics and progress."
          action={
            <Button size="sm" onClick={onAdd}>
              <PlusIcon data-icon="inline-start" />
              Add subject
            </Button>
          }
        />
      ) : subjects.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title={`No matches for "${search}".`}
          description="Try a different search term."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              stats={statsBySubject[subject.id]}
              onOpen={() => onOpen(subject.id)}
              onEdit={() => onEdit(subject)}
              onDelete={() => onDelete(subject)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SubjectCard({
  subject,
  stats,
  onOpen,
  onEdit,
  onDelete,
}: {
  subject: SubjectRecord;
  stats?: { topicCount: number; avgMastery: number | null };
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const colorClass =
    SUBJECT_COLOR_STYLES[subject.color ?? ""] ?? SUBJECT_COLOR_STYLES.violet;

  return (
    <Card
      size="sm"
      className="group cursor-pointer gap-2 transition-colors hover:border-primary/40"
      role="button"
      tabIndex={0}
      aria-label={`Open ${subject.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn("size-2.5 shrink-0 rounded-full", colorClass)}
              aria-hidden="true"
            />
            <CardTitle className="truncate text-sm font-medium">
              {subject.name}
            </CardTitle>
          </div>
          {subject.code || subject.semester ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {[subject.code, subject.semester ? `Semester ${subject.semester}` : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Options for ${subject.name}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <TrashIcon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent>
        {stats && stats.topicCount > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              {stats.topicCount} topic{stats.topicCount === 1 ? "" : "s"}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <Progress
                value={stats.avgMastery ?? 0}
                className="h-1.5 flex-1"
                aria-label={`${subject.name} average mastery ${stats.avgMastery ?? 0} percent`}
              />
              <span className="text-xs font-medium tabular-nums text-muted-foreground">
                {stats.avgMastery === null ? "—" : `${stats.avgMastery}%`}
              </span>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">No topics yet</p>
        )}
      </CardContent>
    </Card>
  );
}
