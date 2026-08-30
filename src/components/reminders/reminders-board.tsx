"use client";

import * as React from "react";
import {
  AlarmClockIcon,
  BellRingIcon,
  CheckCheckIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { mockReminders } from "@/data/mock";
import type { Reminder } from "@/types";

const dayOrder = ["Today", "Tomorrow", "Later"];

function dayGroup(label: string) {
  if (label === "Today" || label === "Tomorrow") return label;
  return "Later";
}

export function RemindersBoard() {
  const [reminders, setReminders] = React.useState<Reminder[]>(mockReminders);
  const [createOpen, setCreateOpen] = React.useState(false);

  const upcoming = reminders.filter((reminder) => !reminder.completed);
  const completed = reminders.filter((reminder) => reminder.completed);

  const grouped = dayOrder.map((day) => ({
    day,
    items: upcoming.filter((reminder) => dayGroup(reminder.dayLabel) === day),
  }));

  const toggle = (reminder: Reminder) => {
    setReminders((items) =>
      items.map((item) =>
        item.id === reminder.id ? { ...item, completed: !item.completed } : item
      )
    );
    toast.success(reminder.completed ? "Reminder restored" : "Reminder done");
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6">
        <PageHeader
          icon={BellRingIcon}
          title="Reminders"
          description="Timely nudges so nothing slips through."
          actions={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Add reminder
            </Button>
          }
        />

        {upcoming.length === 0 ? (
          <EmptyState
            icon={AlarmClockIcon}
            title="No upcoming reminders"
            description="Set a nudge for your next study block."
            action={
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                Add reminder
              </Button>
            }
          />
        ) : (
          grouped
            .filter(({ items }) => items.length > 0)
            .map(({ day, items }) => (
              <section key={day} aria-label={day}>
                <h2 className="pb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  {day}
                </h2>
                <ol className="relative ml-3 space-y-2 border-l pl-5">
                  {items.map((reminder) => (
                    <li key={reminder.id} className="relative">
                      <span
                        aria-hidden="true"
                        className="absolute top-1/2 -left-[27px] size-[11px] -translate-y-1/2 rounded-full border-[3px] border-primary bg-background"
                      />
                      <div className="group flex items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-all hover:ring-primary/30">
                        <Checkbox
                          checked={false}
                          onCheckedChange={() => toggle(reminder)}
                          aria-label={`Mark "${reminder.title}" as done`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {reminder.title}
                        </span>
                        <span className="shrink-0 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary tabular-nums">
                          {reminder.timeLabel}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))
        )}

        {completed.length > 0 ? (
          <section aria-label="Completed reminders">
            <div className="flex items-center gap-2 pb-2">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Completed
              </h2>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setReminders((items) => items.filter((item) => !item.completed));
                  toast.success("Completed reminders cleared");
                }}
              >
                <CheckCheckIcon data-icon="inline-start" />
                Clear all
              </Button>
            </div>
            <ul className="space-y-1.5">
              {completed.map((reminder) => (
                <li
                  key={reminder.id}
                  className="flex items-center gap-3 rounded-xl bg-card p-3 opacity-70 ring-1 ring-foreground/10"
                >
                  <Checkbox
                    checked
                    onCheckedChange={() => toggle(reminder)}
                    aria-label={`Restore "${reminder.title}"`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground line-through">
                    {reminder.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {reminder.dayLabel} · {reminder.timeLabel}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <CreateReminderDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(reminder) => {
          setReminders((items) => [reminder, ...items]);
          setCreateOpen(false);
          toast.success("Reminder created");
        }}
      />
    </div>
  );
}

function CreateReminderDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (reminder: Reminder) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [dayLabel, setDayLabel] = React.useState("Today");
  const [time, setTime] = React.useState("19:00");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      id: crypto.randomUUID(),
      title: title.trim(),
      dayLabel,
      timeLabel: formatTime(time),
      completed: false,
    });
    setTitle("");
    setDayLabel("Today");
    setTime("19:00");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add reminder</DialogTitle>
          <DialogDescription>Spidey Bot will nudge you on time.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="reminder-title">Title</Label>
            <Input
              id="reminder-title"
              placeholder="e.g. Study Physics — Unit 2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Day</Label>
              <Select value={dayLabel} onValueChange={setDayLabel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Today", "Tomorrow"].map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reminder-time">Time</Label>
              <Input
                id="reminder-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!title.trim()}>
            Add reminder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTime(value: string) {
  // value is HH:mm — render a friendly 12-hour label.
  const [hours, minutes] = value.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes ?? 0).padStart(2, "0")} ${period}`;
}
