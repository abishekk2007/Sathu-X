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
import { Textarea } from "@/components/ui/textarea";
import type { StudyGoalRecord } from "@/types";

interface GoalFormValues {
  title: string;
  targetMinutes: string;
  targetDate: string;
  description: string;
}

function initialValues(goal: StudyGoalRecord | null): GoalFormValues {
  return {
    title: goal?.title ?? "",
    targetMinutes:
      goal?.targetMinutes !== null && goal?.targetMinutes !== undefined
        ? String(goal.targetMinutes)
        : "",
    targetDate: goal?.targetDate ?? "",
    description: goal?.description ?? "",
  };
}

/** Add/Edit study-goal dialog ("Study 600 minutes this week"). */
export function GoalFormDialog({
  open,
  onOpenChange,
  editing,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: StudyGoalRecord | null;
  onSubmit: (input: {
    title: string;
    description?: string | null;
    targetDate?: string | null;
    targetMinutes?: number | null;
  }) => Promise<boolean>;
}) {
  const formKey = `${open ? (editing?.id ?? "new") : "closed"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit goal" : "New study goal"}</DialogTitle>
          <DialogDescription>
            Set a minute target — progress is counted from sessions you actually
            complete.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <GoalForm
            key={formKey}
            initial={initialValues(editing)}
            isEditing={Boolean(editing)}
            submittingLabel={editing ? "Saving…" : "Creating…"}
            onSubmit={async (values) => {
              const ok = await onSubmit({
                title: values.title.trim(),
                description: values.description.trim() || null,
                targetDate: values.targetDate || null,
                targetMinutes: values.targetMinutes.trim()
                  ? Number(values.targetMinutes)
                  : null,
              });
              if (ok) {
                onOpenChange(false);
                toast.success(editing ? "Goal updated" : "Goal created");
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GoalForm({
  initial,
  isEditing,
  submittingLabel,
  onSubmit,
}: {
  initial: GoalFormValues;
  isEditing: boolean;
  submittingLabel: string;
  onSubmit: (values: GoalFormValues) => Promise<boolean>;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof GoalFormValues>(
    key: K,
    value: GoalFormValues[K]
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const canSubmit = values.title.trim().length > 0 && !saving;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;

        if (
          values.targetMinutes.trim() &&
          Number(values.targetMinutes) <= 0
        ) {
          setError("Target minutes must be a positive number.");
          return;
        }

        setError(null);
        setSaving(true);
        void onSubmit(values).finally(() => setSaving(false));
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="goal-title">Goal</Label>
        <Input
          id="goal-title"
          value={values.title}
          onChange={(event) => set("title", event.target.value)}
          placeholder='e.g. "Study 10 hours this week"'
          maxLength={160}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="goal-minutes">Target minutes</Label>
          <Input
            id="goal-minutes"
            type="number"
            min={1}
            value={values.targetMinutes}
            onChange={(event) => set("targetMinutes", event.target.value)}
            placeholder="e.g. 600"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="goal-date">Target date</Label>
          <Input
            id="goal-date"
            type="date"
            value={values.targetDate}
            onChange={(event) => set("targetDate", event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="goal-description">Notes</Label>
        <Textarea
          id="goal-description"
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
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
          {saving ? submittingLabel : isEditing ? "Save changes" : "Create goal"}
        </Button>
      </DialogFooter>
    </form>
  );
}
