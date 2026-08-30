"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ExamRecord, SubjectRecord } from "@/types";

// Radix Select forbids empty-string values; "none" maps back to null.
const NO_SUBJECT = "__none__";

export const EXAM_TYPE_LABELS: Record<string, string> = {
  semester: "Semester exam",
  internal: "Internal",
  unit_test: "Unit test",
  practical: "Practical",
  assignment: "Assignment",
  other: "Other",
};

const PRIORITY_LABELS: Record<string, string> = {
  "1": "1 · Low",
  "2": "2 · Below average",
  "3": "3 · Normal",
  "4": "4 · High",
  "5": "5 · Critical",
};

interface ExamFormValues {
  title: string;
  subjectId: string | null;
  examDate: string;
  examType: string;
  targetScore: string;
  priority: string;
  description: string;
}

function initialValues(exam: ExamRecord | null): ExamFormValues {
  return {
    title: exam?.title ?? "",
    subjectId: exam?.subjectId ?? null,
    // <input type="date"> wants a date-only value regardless of the stored
    // instant — the calendar day is what the user picked.
    examDate: exam ? exam.examDate.slice(0, 10) : "",
    examType: exam?.examType ?? "semester",
    targetScore:
      exam?.targetScore !== null && exam?.targetScore !== undefined
        ? String(exam.targetScore)
        : "",
    priority: String(exam?.priority ?? 3),
    description: exam?.description ?? "",
  };
}

/**
 * Add/Edit exam dialog. Validation mirrors the API: name + date required,
 * target score 0–100. The chosen date is sent as a plain local date so the
 * server never shifts the day across timezones.
 */
export function ExamFormDialog({
  open,
  onOpenChange,
  subjects,
  editing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subjects: SubjectRecord[];
  editing: ExamRecord | null;
  onSubmit: (input: {
    title: string;
    examDate: string;
    subjectId?: string | null;
    examType?: string;
    description?: string | null;
    targetScore?: number | null;
    priority?: number;
  }) => Promise<boolean>;
}) {
  // Keyed remount so each open initializes from the target row exactly once.
  const formKey = `${open ? (editing?.id ?? "new") : "closed"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit exam" : "Add exam"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update this exam's details."
              : "Track an upcoming exam so your planner can prepare for it."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ExamForm
            key={formKey}
            initial={initialValues(editing)}
            isEditing={Boolean(editing)}
            subjects={subjects}
            submittingLabel={editing ? "Saving…" : "Creating…"}
            onSubmit={async (values) => {
              const ok = await onSubmit({
                title: values.title.trim(),
                examDate: values.examDate,
                subjectId: values.subjectId === NO_SUBJECT ? null : values.subjectId,
                examType: values.examType,
                description: values.description.trim() || null,
                targetScore: values.targetScore.trim()
                  ? Number(values.targetScore)
                  : null,
                priority: Number(values.priority),
              });
              if (ok) {
                onOpenChange(false);
                toast.success(editing ? "Exam updated" : "Exam added");
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExamForm({
  initial,
  isEditing,
  subjects,
  submittingLabel,
  onSubmit,
}: {
  initial: ExamFormValues;
  isEditing: boolean;
  subjects: SubjectRecord[];
  submittingLabel: string;
  onSubmit: (values: ExamFormValues) => Promise<boolean>;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof ExamFormValues>(
    key: K,
    value: ExamFormValues[K]
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const canSubmit =
    values.title.trim().length > 0 && values.examDate.length > 0 && !saving;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;

        // Guard obviously invalid dates and out-of-range scores client-side.
        const parsedDate = new Date(`${values.examDate}T00:00:00`);
        if (Number.isNaN(parsedDate.getTime())) {
          setError("Enter a valid exam date.");
          return;
        }
        if (
          values.targetScore.trim() &&
          (Number(values.targetScore) < 0 || Number(values.targetScore) > 100)
        ) {
          setError("Target score must be between 0 and 100.");
          return;
        }

        setError(null);
        setSaving(true);
        void onSubmit(values).finally(() => setSaving(false));
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="exam-title">Exam name</Label>
        <Input
          id="exam-title"
          value={values.title}
          onChange={(event) => set("title", event.target.value)}
          placeholder="e.g. Programming in C — Semester exam"
          maxLength={200}
          required
        />
      </div>

      <div className="space-y-2">
        <Label>Subject</Label>
        <Select
          value={values.subjectId ?? NO_SUBJECT}
          onValueChange={(next) =>
            set("subjectId", next === NO_SUBJECT ? null : next)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose a subject" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SUBJECT}>
              <span className="text-muted-foreground">No subject</span>
            </SelectItem>
            {subjects.map((subject) => (
              <SelectItem key={subject.id} value={subject.id}>
                {subject.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="exam-date">Exam date</Label>
          <Input
            id="exam-date"
            type="date"
            value={values.examDate}
            onChange={(event) => set("examDate", event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label>Exam type</Label>
          <Select
            value={values.examType}
            onValueChange={(next) => set("examType", next)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(EXAM_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="exam-target">Target score (0–100)</Label>
          <Input
            id="exam-target"
            type="number"
            min={0}
            max={100}
            value={values.targetScore}
            onChange={(event) => set("targetScore", event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="space-y-2">
          <Label>Priority</Label>
          <Select
            value={values.priority}
            onValueChange={(next) => set("priority", next)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="exam-description">Description</Label>
        <Textarea
          id="exam-description"
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          placeholder="Syllabus coverage, notes… (optional)"
          rows={2}
          maxLength={1000}
        />
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? submittingLabel : isEditing ? "Save changes" : "Create exam"}
        </Button>
      </DialogFooter>
    </form>
  );
}
