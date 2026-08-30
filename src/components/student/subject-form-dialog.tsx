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
import type { SubjectRecord } from "@/types";

const SUBJECT_COLORS = [
  "violet",
  "blue",
  "emerald",
  "amber",
  "rose",
  "cyan",
] as const;

interface SubjectFormValues {
  name: string;
  code: string;
  semester: string;
  description: string;
  color: string;
}

function initialValues(subject: SubjectRecord | null): SubjectFormValues {
  return {
    name: subject?.name ?? "",
    code: subject?.code ?? "",
    semester: subject?.semester ?? "",
    description: subject?.description ?? "",
    color: subject?.color ?? "violet",
  };
}

/**
 * Add/Edit subject dialog. All fields except the name are optional —
 * users are never forced to fill in metadata.
 */
export function SubjectFormDialog({
  open,
  onOpenChange,
  subject,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: SubjectRecord | null;
  onSubmit: (
    input: {
      name: string;
      code?: string | null;
      description?: string | null;
      semester?: string | null;
      color?: string | null;
    }
  ) => Promise<boolean>;
}) {
  // Keyed remount so each open initializes from the target row exactly once.
  const formKey = `${open ? (subject?.id ?? "new") : "closed"}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{subject ? "Edit subject" : "Add subject"}</DialogTitle>
          <DialogDescription>
            {subject
              ? "Update this subject's details."
              : "Create a subject you're studying, e.g. Programming in C."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <SubjectForm
            key={formKey}
            initial={initialValues(subject)}
            isEditing={Boolean(subject)}
            submittingLabel={subject ? "Saving…" : "Creating…"}
            onSubmit={async (values) => {
              const ok = await onSubmit({
                name: values.name.trim(),
                code: values.code.trim() || null,
                semester: values.semester.trim() || null,
                description: values.description.trim() || null,
                color: values.color,
              });
              if (ok) {
                onOpenChange(false);
                toast.success(subject ? "Subject updated" : "Subject added");
              } else {
                toast.error("Could not save the subject. Please try again.");
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SubjectForm({
  initial,
  isEditing,
  onSubmit,
  submittingLabel,
}: {
  initial: SubjectFormValues;
  isEditing: boolean;
  onSubmit: (values: SubjectFormValues) => Promise<boolean>;
  submittingLabel: string;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof SubjectFormValues>(
    key: K,
    value: SubjectFormValues[K]
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const canSubmit = values.name.trim().length > 0 && !saving;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setSaving(true);
        void onSubmit(values).finally(() => setSaving(false));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="subject-name">Name</Label>
        <Input
          id="subject-name"
          value={values.name}
          maxLength={120}
          placeholder="e.g. Engineering Physics"
          onChange={(event) => set("name", event.target.value)}
          autoFocus
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="subject-code">Code</Label>
          <Input
            id="subject-code"
            value={values.code}
            maxLength={40}
            placeholder="e.g. 23PH1201"
            onChange={(event) => set("code", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="subject-semester">Semester</Label>
          <Input
            id="subject-semester"
            value={values.semester}
            maxLength={40}
            placeholder="e.g. 1"
            onChange={(event) => set("semester", event.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="subject-description">Description</Label>
        <Textarea
          id="subject-description"
          value={values.description}
          maxLength={1000}
          rows={2}
          placeholder="Optional notes about this subject."
          onChange={(event) => set("description", event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Color</Label>
        <div className="flex gap-2" role="radiogroup" aria-label="Subject color">
          {SUBJECT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={values.color === color}
              aria-label={color}
              onClick={() => set("color", color)}
              className={`size-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition-shadow ${
                SUBJECT_COLOR_STYLES[color]
              } ${
                values.color === color
                  ? "ring-primary"
                  : "ring-transparent hover:ring-muted"
              }`}
            />
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? submittingLabel : isEditing ? "Save changes" : "Add subject"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export const SUBJECT_COLOR_STYLES: Record<string, string> = {
  violet: "bg-violet-500/80",
  blue: "bg-blue-500/80",
  emerald: "bg-emerald-500/80",
  amber: "bg-amber-500/80",
  rose: "bg-rose-500/80",
  cyan: "bg-cyan-500/80",
};
