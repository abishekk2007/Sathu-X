"use client";

import * as React from "react";
import { BookOpenIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ChatContextSelection,
  SubjectRecord,
  TopicRecord,
} from "@/types";

const CONTEXT_NONE = "__none__";

/**
 * Subject/topic picker shown above the chat composer. The selection is sent
 * with every chat request so the server can attach the exact academic context.
 * Document/source selection is now handled by the [+] Add Context menu.
 */
export function ChatContextSelector({
  value,
  onChange,
}: {
  value: ChatContextSelection;
  onChange: (value: ChatContextSelection) => void;
}) {
  const [subjects, setSubjects] = React.useState<SubjectRecord[] | null>(null);
  const [topicsBySubject, setTopicsBySubject] = React.useState<
    Record<string, TopicRecord[]>
  >({});
  const [loadingSubjectId, setLoadingSubjectId] = React.useState<string | null>(null);

  const topics = value.subjectId ? (topicsBySubject[value.subjectId] ?? []) : [];
  const topicsLoading = loadingSubjectId === value.subjectId;

  React.useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        try {
          const response = await fetch("/api/subjects?limit=100", {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return;
          const data = (await response.json()) as { subjects?: SubjectRecord[] };
          if (!cancelled) setSubjects(Array.isArray(data.subjects) ? data.subjects : []);
        } catch {
          /* selector simply stays hidden on failure */
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const subjectId = value.subjectId;
    if (!subjectId || topicsBySubject[subjectId]) return;
    let cancelled = false;
    queueMicrotask(() => {
      setLoadingSubjectId(subjectId);
      void (async () => {
        try {
          const response = await fetch(`/api/subjects/${subjectId}/topics`, {
            headers: { Accept: "application/json" },
          });
          if (!response.ok) return;
          const data = (await response.json()) as { topics?: TopicRecord[] };
          if (cancelled) return;
          setTopicsBySubject((previous) => ({
            ...previous,
            [subjectId]: Array.isArray(data.topics) ? data.topics : [],
          }));
        } catch {
          /* keep empty list for this subject */
        } finally {
          if (!cancelled) setLoadingSubjectId(null);
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, [value.subjectId, topicsBySubject]);

  const hasSubjects = subjects !== null && subjects.length > 0;
  if (!hasSubjects) return null;

  const selectedSubject = subjects?.find((s) => s.id === value.subjectId);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <Select
          value={value.subjectId ?? CONTEXT_NONE}
          onValueChange={(next) =>
            onChange({
              subjectId: next === CONTEXT_NONE ? undefined : next,
              topicId: undefined,
            })
          }
        >
          <SelectTrigger
            size="sm"
            className="h-7 max-w-[13rem] border-none bg-muted/60 text-xs shadow-none"
            aria-label="Chat about a subject"
          >
            <SelectValue placeholder="Subject" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CONTEXT_NONE}>
              <span className="text-muted-foreground">No subject</span>
            </SelectItem>
            {(subjects ?? []).map((subject) => (
              <SelectItem key={subject.id} value={subject.id}>
                {subject.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedSubject ? (
          <Select
            value={value.topicId ?? CONTEXT_NONE}
            onValueChange={(next) =>
              onChange({
                ...value,
                topicId: next === CONTEXT_NONE ? undefined : next,
              })
            }
          >
            <SelectTrigger
              size="sm"
              className="h-7 max-w-[13rem] border-none bg-muted/60 text-xs shadow-none"
              aria-label="Chat about a topic"
            >
              <SelectValue placeholder={topicsLoading ? "Loading…" : "Topic"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CONTEXT_NONE}>
                <span className="text-muted-foreground">All topics</span>
              </SelectItem>
              {topics.map((topic) => (
                <SelectItem key={topic.id} value={topic.id}>
                  {topic.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {value.subjectId || value.topicId ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            aria-label="Clear context"
            onClick={() => onChange({})}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
