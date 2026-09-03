"use client";

import * as React from "react";

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
import type { ExamRecord } from "@/types";

// Radix Select forbids empty-string values.
const NO_EXAM = "__none__";

const DAY_OPTIONS = [
  { value: "0", label: "Sun" },
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
];

const ALL_DAYS = ["0", "1", "2", "3", "4", "5", "6"];

interface GenerateFormValues {
  name: string;
  examId: string | null;
  startDate: string;
  endDate: string;
  dailyMinutes: string;
  preferredDays: string[];
  preferredTime: string;
  replaceFutureSessions: boolean;
}

function defaultDates(): { startDate: string; endDate: string } {
  const today = new Date();
  const twoWeeks = new Date(today.getTime() + 13 * 86_400_000);
  return {
    startDate: toLocalDateInput(today),
    endDate: toLocalDateInput(twoWeeks),
  };
}

function toLocalDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Plan generation dialog — the single entry point for both creating a plan
 * and regenerating an existing one (regeneration asks for confirmation and
 * only ever replaces future unfinished sessions server-side).
 */
export function PlanGenerateDialog({
  open,
  onOpenChange,
  exams,
  regeneratePlanId,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exams: ExamRecord[];
  /** When set, this is a regeneration of that plan. */
  regeneratePlanId?: string | null;
  onSubmit: (input: {
    name: string;
    startDate: string;
    endDate: string;
    dailyMinutes: number;
    preferredTime?: string | null;
    preferredDays?: number[] | null;
    examId?: string | null;
    planId?: string | null;
    replaceFutureSessions?: boolean;
  }) => Promise<boolean>;
}) {
  const formKey = `${open ? (regeneratePlanId ?? "new") : "closed"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {regeneratePlanId ? "Regenerate study plan" : "Generate study plan"}
          </DialogTitle>
          <DialogDescription>
            SathuX builds a schedule around your upcoming exams and weakest
            topics. You can adjust any session afterwards.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <GenerateForm
            key={formKey}
            initial={{
              name: "",
              examId:
                exams.find((exam) => new Date(exam.examDate) > new Date())?.id ??
                null,
              ...defaultDates(),
              dailyMinutes: "90",
              preferredDays: ALL_DAYS,
              preferredTime: "",
              replaceFutureSessions: false,
            }}
            exams={exams}
            isRegeneration={Boolean(regeneratePlanId)}
            submittingLabel={
              regeneratePlanId ? "Regenerating…" : "Generating…"
            }
            onSubmit={async (values) => {
              const ok = await onSubmit({
                name: values.name.trim(),
                startDate: values.startDate,
                endDate: values.endDate,
                dailyMinutes: Number(values.dailyMinutes),
                preferredTime: values.preferredTime || null,
                preferredDays: values.preferredDays.map(Number),
                examId: values.examId === NO_EXAM ? null : values.examId,
                planId: regeneratePlanId ?? undefined,
                replaceFutureSessions: regeneratePlanId
                  ? values.replaceFutureSessions
                  : undefined,
              });
              if (ok) {
                onOpenChange(false);
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GenerateForm({
  initial,
  exams,
  isRegeneration,
  submittingLabel,
  onSubmit,
}: {
  initial: GenerateFormValues;
  exams: ExamRecord[];
  isRegeneration: boolean;
  submittingLabel: string;
  onSubmit: (values: GenerateFormValues) => Promise<boolean>;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof GenerateFormValues>(
    key: K,
    value: GenerateFormValues[K]
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  // The API requires a window of at least one full day.
  const canSubmit =
    values.examId !== null &&
    values.startDate.length > 0 &&
    values.endDate.length > 0 &&
    Number(values.dailyMinutes) > 0 &&
    values.preferredDays.length > 0 &&
    !saving;

  const toggleDay = (day: string) => {
    setValues((previous) => {
      const has = previous.preferredDays.includes(day);
      return {
        ...previous,
        preferredDays: has
          ? previous.preferredDays.filter((value) => value !== day)
          : [...previous.preferredDays, day],
      };
    });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;

        if (new Date(`${values.startDate}T00:00:00`) > new Date(`${values.endDate}T00:00:00`)) {
          setError("The end date must be on or after the start date.");
          return;
        }

        setError(null);
        setSaving(true);
        void onSubmit(values).finally(() => setSaving(false));
      }}
    >
      {!isRegeneration ? (
        <div className="space-y-2">
          <Label htmlFor="plan-name">Plan name</Label>
          <Input
            id="plan-name"
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder='e.g. "Semester prep"'
            maxLength={120}
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <Label>Prepare for exam</Label>
        <Select
          value={values.examId ?? NO_EXAM}
          onValueChange={(next) =>
            set("examId", next === NO_EXAM ? null : next)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose an upcoming exam" />
          </SelectTrigger>
          <SelectContent>
            {exams.length === 0 ? (
              <SelectItem value={NO_EXAM} disabled>
                No exams yet
              </SelectItem>
            ) : (
              exams.map((exam) => (
                <SelectItem key={exam.id} value={exam.id}>
                  {exam.title}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        {exams.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add an exam first so the planner knows what to prepare for.
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="plan-start">Start date</Label>
          <Input
            id="plan-start"
            type="date"
            value={values.startDate}
            onChange={(event) => set("startDate", event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="plan-end">End date</Label>
          <Input
            id="plan-end"
            type="date"
            value={values.endDate}
            onChange={(event) => set("endDate", event.target.value)}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="plan-minutes">Daily study minutes</Label>
          <Input
            id="plan-minutes"
            type="number"
            min={15}
            max={600}
            step={15}
            value={values.dailyMinutes}
            onChange={(event) => set("dailyMinutes", event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="plan-time">Preferred start time</Label>
          <Input
            id="plan-time"
            type="time"
            value={values.preferredTime}
            onChange={(event) => set("preferredTime", event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Preferred days</Label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Preferred days">
          {DAY_OPTIONS.map((day) => {
            const active = values.preferredDays.includes(day.value);
            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleDay(day.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {day.label}
              </button>
            );
          })}
        </div>
      </div>

      {isRegeneration ? (
        <label className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={values.replaceFutureSessions}
            onChange={(event) =>
              set("replaceFutureSessions", event.target.checked)
            }
          />
          <span>
            Replace my future sessions in{" "}
            <span className="font-medium">this plan</span>. Sessions you already
            completed are always kept.
          </span>
        </label>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? submittingLabel : isRegeneration ? "Regenerate" : "Generate"}
        </Button>
      </DialogFooter>
    </form>
  );
}
