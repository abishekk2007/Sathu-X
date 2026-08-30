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
import type { StudySessionRecord } from "@/types";

export const SESSION_TYPE_LABELS: Record<string, string> = {
  study: "Study",
  revision: "Revision",
  practice: "Practice",
  mock_test: "Mock test",
  review: "Review",
};

interface SessionFormValues {
  scheduledDate: string;
  startTime: string;
  durationMinutes: string;
  sessionType: string;
  notes: string;
}

function initialValues(session: StudySessionRecord): SessionFormValues {
  return {
    scheduledDate: session.scheduledDate,
    // Stored as HH:MM(:SS) — <input type="time"> wants HH:MM.
    startTime: session.startTime ? session.startTime.slice(0, 5) : "",
    durationMinutes: String(session.durationMinutes),
    sessionType: session.sessionType ?? "study",
    notes: session.notes ?? "",
  };
}

/** Reschedule / adjust a single study session (date, time, duration, type). */
export function SessionEditDialog({
  session,
  onOpenChange,
  onSubmit,
}: {
  session: StudySessionRecord | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    id: string,
    input: {
      scheduledDate?: string | null;
      startTime?: string | null;
      durationMinutes?: number | null;
      sessionType?: string | null;
      notes?: string | null;
    }
  ) => Promise<boolean>;
}) {
  const formKey = `${session ? session.id : "closed"}`;

  return (
    <Dialog
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit session</DialogTitle>
          <DialogDescription>
            {session?.subjectName ?? session?.topicName
              ? `${[session.subjectName, session.topicName]
                  .filter(Boolean)
                  .join(" · ")}`
              : "Adjust this study session."}
          </DialogDescription>
        </DialogHeader>
        {session ? (
          <SessionForm
            key={formKey}
            initial={initialValues(session)}
            submittingLabel="Saving…"
            onSubmit={async (values) => {
              const ok = await onSubmit(session.id, {
                scheduledDate: values.scheduledDate || null,
                startTime: values.startTime || null,
                durationMinutes: Number(values.durationMinutes),
                sessionType: values.sessionType,
                notes: values.notes.trim() || null,
              });
              if (ok) {
                onOpenChange(false);
                toast.success("Session updated");
              }
              return ok;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SessionForm({
  initial,
  submittingLabel,
  onSubmit,
}: {
  initial: SessionFormValues;
  submittingLabel: string;
  onSubmit: (values: SessionFormValues) => Promise<boolean>;
}) {
  const [values, setValues] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof SessionFormValues>(
    key: K,
    value: SessionFormValues[K]
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const canSubmit =
    values.scheduledDate.length > 0 && Number(values.durationMinutes) > 0;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setError(null);
        setSaving(true);
        void onSubmit(values).finally(() => setSaving(false));
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="session-date">Date</Label>
          <Input
            id="session-date"
            type="date"
            value={values.scheduledDate}
            onChange={(event) => set("scheduledDate", event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="session-time">Start time</Label>
          <Input
            id="session-time"
            type="time"
            value={values.startTime}
            onChange={(event) => set("startTime", event.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="session-duration">Duration (minutes)</Label>
          <Input
            id="session-duration"
            type="number"
            min={5}
            max={480}
            step={5}
            value={values.durationMinutes}
            onChange={(event) => set("durationMinutes", event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label>Session type</Label>
          <Select
            value={values.sessionType}
            onValueChange={(next) => set("sessionType", next)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SESSION_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="session-notes">Notes</Label>
        <Textarea
          id="session-notes"
          value={values.notes}
          onChange={(event) => set("notes", event.target.value)}
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
          {saving ? submittingLabel : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
