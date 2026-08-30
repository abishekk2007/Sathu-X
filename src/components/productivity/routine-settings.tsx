"use client";

import * as React from "react";
import { SettingsIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { RoutineRecord } from "@/types";

const STUDY_TIME_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
  { value: "night", label: "Night" },
  { value: "flexible", label: "Flexible" },
] as const;

export function RoutineSettings({
  routine,
  loading,
  onSave,
}: {
  routine: RoutineRecord | null;
  loading: boolean;
  onSave: (patch: {
    preferredSessionMinutes?: number | null;
    preferredBreakMinutes?: number | null;
    preferredStudyTime?: string | null;
    dailyStudyTargetMinutes?: number | null;
  }) => Promise<boolean>;
}) {
  const [sessionMinutes, setSessionMinutes] = React.useState(
    () => routine?.preferredSessionMinutes?.toString() ?? ""
  );
  const [breakMinutes, setBreakMinutes] = React.useState(
    () => routine?.preferredBreakMinutes?.toString() ?? ""
  );
  const [studyTime, setStudyTime] = React.useState(
    () => routine?.preferredStudyTime ?? ""
  );
  const [dailyTarget, setDailyTarget] = React.useState(
    () => routine?.dailyStudyTargetMinutes?.toString() ?? ""
  );
  const [saving, setSaving] = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave({
      preferredSessionMinutes: sessionMinutes ? Number(sessionMinutes) : null,
      preferredBreakMinutes: breakMinutes ? Number(breakMinutes) : null,
      preferredStudyTime: studyTime || null,
      dailyStudyTargetMinutes: dailyTarget ? Number(dailyTarget) : null,
    });
    setSaving(false);
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
          <SettingsIcon className="size-4 text-primary" />
          Study routine preferences
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-9 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Session length (min)</span>
                <Input
                  type="number"
                  min={5}
                  max={240}
                  value={sessionMinutes}
                  onChange={(e) => setSessionMinutes(e.target.value)}
                  placeholder="e.g. 45"
                  className="h-8 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">Break length (min)</span>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={breakMinutes}
                  onChange={(e) => setBreakMinutes(e.target.value)}
                  placeholder="e.g. 10"
                  className="h-8 text-sm"
                />
              </label>
            </div>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Preferred study time</span>
              <select
                value={studyTime}
                onChange={(e) => setStudyTime(e.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Any time</option>
                {STUDY_TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Daily study target (min)</span>
              <Input
                type="number"
                min={0}
                max={720}
                value={dailyTarget}
                onChange={(e) => setDailyTarget(e.target.value)}
                placeholder="e.g. 120"
                className="h-8 text-sm"
              />
            </label>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="w-full"
            >
              {saving ? "Saving…" : "Save preferences"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
