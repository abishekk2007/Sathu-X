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

interface TopicFormValues {
  name: string;
  unit: string;
  description: string;
}

/**
 * Add/Edit topic dialog. Name is required; unit and description are optional.
 */
export function TopicFormDialog({
  open,
  onOpenChange,
  topicName,
  initialName,
  initialUnit,
  initialDescription,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Subject name shown in the copy for context. */
  topicName: string;
  initialName?: string;
  initialUnit?: string | null;
  initialDescription?: string | null;
  onSubmit: (input: {
    name: string;
    unit: string | null;
    description: string | null;
  }) => Promise<boolean>;
}) {
  const editing = Boolean(initialName);
  const formKey = `${open ? (initialName ?? "new") : "closed"}-${topicName}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit topic" : "Add topic"}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update this topic in ${topicName}.`
              : `Add a topic you're learning in ${topicName}.`}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <TopicForm
            key={formKey}
            initial={{
              name: initialName ?? "",
              unit: initialUnit ?? "",
              description: initialDescription ?? "",
            }}
            submittingLabel={editing ? "Saving…" : "Adding…"}
            submitLabel={editing ? "Save changes" : "Add topic"}
            onSubmit={async (values) => {
              const ok = await onSubmit({
                name: values.name.trim(),
                unit: values.unit.trim() || null,
                description: values.description.trim() || null,
              });
              if (ok) {
                onOpenChange(false);
                toast.success(editing ? "Topic updated" : "Topic added");
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TopicForm({
  initial,
  onSubmit,
  submittingLabel,
  submitLabel,
}: {
  initial: TopicFormValues;
  onSubmit: (values: TopicFormValues) => Promise<boolean>;
  submittingLabel: string;
  submitLabel: string;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof TopicFormValues>(
    key: K,
    value: TopicFormValues[K]
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
        <Label htmlFor="topic-name">Topic name</Label>
        <Input
          id="topic-name"
          value={values.name}
          maxLength={160}
          placeholder="e.g. Pointers"
          onChange={(event) => set("name", event.target.value)}
          autoFocus
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="topic-unit">Unit</Label>
        <Input
          id="topic-unit"
          value={values.unit}
          maxLength={40}
          placeholder="e.g. 2"
          onChange={(event) => set("unit", event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="topic-description">Description</Label>
        <Textarea
          id="topic-description"
          value={values.description}
          maxLength={1000}
          rows={2}
          placeholder="Optional notes about this topic."
          onChange={(event) => set("description", event.target.value)}
        />
      </div>

      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {saving ? submittingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
