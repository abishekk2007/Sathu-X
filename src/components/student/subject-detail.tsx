"use client";

import * as React from "react";
import {
  ArrowLeftIcon,
  CheckIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TopicFormDialog } from "@/components/student/topic-form-dialog";
import { ErrorState } from "@/components/shared/error-state";
import type { SubjectRecord, TopicRecord, TopicStatus } from "@/types";
import { formatReviewedLabel } from "@/lib/utils";

const STATUS_LABELS: Record<TopicStatus, string> = {
  not_started: "Not started",
  learning: "Learning",
  review: "Needs review",
  mastered: "Mastered",
};

const STATUS_BADGE_CLASSES: Record<TopicStatus, string> = {
  not_started: "bg-muted text-muted-foreground",
  learning: "bg-blue-500/15 text-blue-500 dark:text-blue-400",
  review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  mastered: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

const TOPIC_STATUSES: TopicStatus[] = [
  "not_started",
  "learning",
  "review",
  "mastered",
];

/**
 * Full subject view: progress summary plus per-unit topic management
 * (status/mastery editing and one-tap practice outcome recording).
 */
export function SubjectDetail({
  subject,
  topics,
  topicsLoading,
  topicsError,
  onBack,
  onReloadTopics,
  onEditSubject,
  onUpdateTopic,
  onDeleteTopic,
  onDeleteSubject,
  onAddTopic,
  onPractice,
}: {
  subject: SubjectRecord;
  topics: TopicRecord[];
  topicsLoading: boolean;
  topicsError: boolean;
  onBack: () => void;
  onReloadTopics: () => void;
  onEditSubject: () => void;
  onUpdateTopic: (
    topic: Pick<TopicRecord, "id" | "subjectId">,
    patch: {
      name?: string;
      unit?: string | null;
      description?: string | null;
      status?: TopicStatus;
      mastery?: number;
    }
  ) => Promise<boolean>;
  onDeleteTopic: (topic: Pick<TopicRecord, "id" | "subjectId">) => void;
  onDeleteSubject: () => void;
  onAddTopic: () => void;
  onPractice: (
    topic: Pick<TopicRecord, "id" | "subjectId">,
    correct: boolean
  ) => void;
}) {
  const [editTopic, setEditTopic] = React.useState<TopicRecord | null>(null);
  const [topicDialogOpen, setTopicDialogOpen] = React.useState(false);

  const avgMastery =
    topics.length === 0
      ? null
      : Math.round(
          topics.reduce((sum, topic) => sum + topic.mastery, 0) / topics.length
        );

  // Group by unit (blank units fall into a trailing "General" group).
  const groups = React.useMemo(() => {
    const map = new Map<string, TopicRecord[]>();
    for (const topic of topics) {
      const key = topic.unit?.trim() || "General";
      const list = map.get(key);
      if (list) list.push(topic);
      else map.set(key, [topic]);
    }
    return [...map.entries()];
  }, [topics]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-1"
            onClick={onBack}
          >
            <ArrowLeftIcon data-icon="inline-start" />
            All subjects
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">
            {subject.name}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
            {subject.code ? <span>{subject.code}</span> : null}
            {subject.semester ? <span>Semester {subject.semester}</span> : null}
            {topics.length > 0 ? (
              <span>
                {topics.length} topic{topics.length === 1 ? "" : "s"}
                {avgMastery !== null ? ` · ${avgMastery}% mastery` : ""}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEditSubject}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
          <Button size="sm" onClick={onAddTopic}>
            <PlusIcon data-icon="inline-start" />
            Add topic
          </Button>
        </div>
      </div>

      {avgMastery !== null ? (
        <Progress value={avgMastery} className="h-1.5" aria-label={`Average mastery ${avgMastery} percent`} />
      ) : null}

      {topicsLoading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : topicsError ? (
        <ErrorState
          title="Couldn't load topics."
          description="Check your connection and try again."
          onRetry={onReloadTopics}
        />
      ) : topics.length === 0 ? (
        <Card className="border-dashed bg-transparent shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="font-medium">No topics yet.</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Add the first topic you&apos;re learning in this subject.
            </p>
            <Button size="sm" onClick={onAddTopic}>
              <PlusIcon data-icon="inline-start" />
              Add topic
            </Button>
          </CardContent>
        </Card>
      ) : (
        groups.map(([unit, unitTopics]) => (
          <section key={unit} aria-label={unit} className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {unit}
            </h3>
            <div className="space-y-2">
              {unitTopics.map((topic) => (
                <TopicRow
                  key={topic.id}
                  topic={topic}
                  onEdit={() => {
                    setEditTopic(topic);
                    setTopicDialogOpen(true);
                  }}
                  onDelete={() =>
                    onDeleteTopic({ id: topic.id, subjectId: topic.subjectId })
                  }
                  onUpdateTopic={onUpdateTopic}
                  onPractice={onPractice}
                />
              ))}
            </div>
          </section>
        ))
      )}

      <div className="pt-1">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDeleteSubject}
        >
          <Trash2Icon data-icon="inline-start" />
          Delete subject
        </Button>
      </div>

      <TopicFormDialog
        open={topicDialogOpen && editTopic !== null}
        onOpenChange={(open) => {
          setTopicDialogOpen(open);
          if (!open) setEditTopic(null);
        }}
        topicName={subject.name}
        initialName={editTopic?.name}
        initialUnit={editTopic?.unit}
        initialDescription={editTopic?.description}
        onSubmit={async (input) => {
          if (!editTopic) return false;
          return onUpdateTopic(
            { id: editTopic.id, subjectId: editTopic.subjectId },
            input
          );
        }}
      />

      {/* Hidden add-topic dialog host — opened via parent state. */}
      {/* Add-topic dialog lives in the parent (StudentView). */}
    </div>
  );
}

function TopicRow({
  topic,
  onEdit,
  onDelete,
  onUpdateTopic,
  onPractice,
}: {
  topic: TopicRecord;
  onEdit: () => void;
  onDelete: () => void;
  onUpdateTopic: (
    topic: Pick<TopicRecord, "id" | "subjectId">,
    patch: {
      name?: string;
      unit?: string | null;
      description?: string | null;
      status?: TopicStatus;
      mastery?: number;
    }
  ) => Promise<boolean>;
  onPractice: (
    topic: Pick<TopicRecord, "id" | "subjectId">,
    correct: boolean
  ) => void;
}) {
  const status = (TOPIC_STATUSES.includes(topic.status)
    ? topic.status
    : "not_started") as TopicStatus;

  // Local mastery editing: commit on blur/Enter so typing isn't spammy.
  // When the saved mastery changes (practice outcomes, external edits),
  // re-sync the draft during render per React's "adjusting state" pattern.
  const [masteryDraft, setMasteryDraft] = React.useState(String(topic.mastery));
  const [syncedMastery, setSyncedMastery] = React.useState(topic.mastery);
  if (syncedMastery !== topic.mastery) {
    setSyncedMastery(topic.mastery);
    setMasteryDraft(String(topic.mastery));
  }

  const commitMastery = async () => {
    const parsed = Number.parseInt(masteryDraft, 10);
    if (!Number.isFinite(parsed) || parsed === topic.mastery) {
      setMasteryDraft(String(topic.mastery));
      return;
    }
    const clamped = Math.max(0, Math.min(100, parsed));
    const ok = await onUpdateTopic(
      { id: topic.id, subjectId: topic.subjectId },
      { mastery: clamped }
    );
    if (!ok) {
      setMasteryDraft(String(topic.mastery));
      toast.error("Could not update mastery.");
    }
  };

  const changeStatus = async (next: TopicStatus) => {
    if (next === status) return;
    const ok = await onUpdateTopic(
      { id: topic.id, subjectId: topic.subjectId },
      { status: next }
    );
    if (!ok) toast.error("Could not update status.");
  };

  const reviewedLabel = formatReviewedLabel(topic.lastReviewedAt);

  return (
    <Card size="sm" className="gap-3 py-3">
      <CardHeader className="min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 space-y-0 px-4">
        <CardTitle className="min-w-0 flex-1 truncate text-sm font-medium">
          {topic.name}
        </CardTitle>

        <Select value={status} onValueChange={(value) => void changeStatus(value as TopicStatus)}>
          <SelectTrigger
            size="sm"
            className={`w-[7.75rem] shrink-0 border-none bg-muted/60 text-xs shadow-none ${STATUS_BADGE_CLASSES[status]}`}
            aria-label={`Status for ${topic.name}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TOPIC_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>

      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4">
        <div className="flex min-w-[9rem] flex-1 items-center gap-2">
          <Progress
            value={topic.mastery}
            className="h-1.5 flex-1"
            aria-label={`${topic.name} mastery ${topic.mastery} percent`}
          />
          <Input
            value={masteryDraft}
            inputMode="numeric"
            maxLength={3}
            className="h-7 w-12 px-1.5 text-right text-xs tabular-nums"
            aria-label={`Mastery percent for ${topic.name}`}
            onChange={(event) =>
              setMasteryDraft(event.target.value.replace(/[^0-9]/g, ""))
            }
            onBlur={() => void commitMastery()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </div>

        <span className="text-[11px] text-muted-foreground">
          {reviewedLabel || "never practiced"}
        </span>

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Mark a correct practice result for ${topic.name}`}
            onClick={() => onPractice({ id: topic.id, subjectId: topic.subjectId }, true)}
          >
            <CheckIcon className="text-emerald-500" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Mark an incorrect practice result for ${topic.name}`}
            onClick={() => onPractice({ id: topic.id, subjectId: topic.subjectId }, false)}
          >
            <XIcon className="text-rose-500" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More options for ${topic.name}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon />
                Edit topic
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
