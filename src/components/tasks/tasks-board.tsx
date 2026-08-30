"use client";

import * as React from "react";
import {
  CalendarDaysIcon,
  ListChecksIcon,
  PlusIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { PriorityDot } from "@/components/shared/priority-dot";
import { useTasks } from "@/hooks/use-tasks";
import type { ClientTask, TaskBucket, TaskPriority, TaskRecurrence } from "@/types";

const bucketMeta: Record<TaskBucket, { title: string }> = {
  today: { title: "Today" },
  upcoming: { title: "Upcoming" },
  completed: { title: "Completed" },
};

function dayKey(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function taskBucket(task: ClientTask, nowKey: string, timeZone: string): TaskBucket {
  if (task.status === "completed") return "completed";
  if (task.status === "cancelled" || task.status === "failed") return "completed";
  if (!task.dueAt) return "upcoming";
  const dueKey = dayKey(task.dueAt, timeZone);
  if (dueKey && dueKey <= nowKey) return "today";
  return "upcoming";
}

function dueLabel(task: ClientTask, timeZone: string, nowKey: string): string {
  if (!task.dueAt) return "No due date";
  const key = dayKey(task.dueAt, timeZone);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(task.dueAt));
  if (key === nowKey) return `Today, ${time}`;
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(task.dueAt));
  return `${dateLabel}, ${time}`;
}

export function TasksBoard() {
  const { tasks, loading, reload, add, update, remove } = useTasks();
  const [createOpen, setCreateOpen] = React.useState(false);

  // Client timezone, recomputed only when the tab regains focus — due labels
  // keep tracking the user's wall clock without re-fetching the list.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowKey = dayKey(new Date().toISOString(), timeZone) ?? "";

  const buckets: Record<TaskBucket, ClientTask[]> = {
    today: [],
    upcoming: [],
    completed: [],
  };
  for (const task of tasks) {
    buckets[taskBucket(task, nowKey, timeZone)].push(task);
  }

  const toggle = async (task: ClientTask) => {
    const nextStatus = task.status === "completed" ? "pending" : "completed";
    const ok = await update(task.id, { status: nextStatus });
    if (ok) toast.success(nextStatus === "completed" ? "Task completed" : "Task reopened");
    else toast.error("Couldn't update the task");
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6">
        <PageHeader
          icon={ListChecksIcon}
          title="Tasks"
          description="Everything you need to get done — study and life."
          actions={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              Create task
            </Button>
          }
        />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading your tasks…</p>
        ) : (
          (["today", "upcoming", "completed"] as TaskBucket[]).map((bucket) => (
            <section key={bucket} aria-label={bucketMeta[bucket].title}>
              <h2 className="flex items-center gap-2 pb-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                {bucketMeta[bucket].title}
                <Badge variant="secondary" className="text-[11px]">
                  {buckets[bucket].length}
                </Badge>
              </h2>

              {buckets[bucket].length === 0 ? (
                bucket === "completed" ? null : (
                  <EmptyState
                    icon={CalendarDaysIcon}
                    title={
                      bucket === "today"
                        ? "Nothing due today"
                        : "No upcoming tasks"
                    }
                    description={
                      bucket === "today"
                        ? "Enjoy the calm — or plan ahead with a new task."
                        : "Create a task to keep momentum going."
                    }
                    action={
                      <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                        Create task
                      </Button>
                    }
                  />
                )
              ) : (
                <ul className="space-y-1.5">
                  {buckets[bucket].map((task) => (
                    <li key={task.id}>
                      <div className="group flex items-center gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 transition-all hover:ring-primary/30">
                        <Checkbox
                          checked={task.status === "completed"}
                          onCheckedChange={() => toggle(task)}
                          aria-label={`Mark "${task.title}" as ${task.status === "completed" ? "not done" : "done"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-sm font-medium ${
                              task.status === "completed"
                                ? "text-muted-foreground line-through"
                                : ""
                            }`}
                          >
                            {task.title}
                          </span>
                          <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                            {dueLabel(task, timeZone, nowKey)}
                            <span aria-hidden="true">•</span>
                            <PriorityDot priority={task.priority} showLabel={false} />
                            {task.priority}
                          </span>
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          {task.recurrence !== "none" && (
                            <Badge variant="secondary" className="font-normal">
                              {task.recurrence}
                            </Badge>
                          )}
                          <Badge variant="outline" className="font-normal text-muted-foreground">
                            {task.category}
                          </Badge>
                          {task.status === "pending" && (
                            <button
                              type="button"
                              className="text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => void remove(task.id).then((ok) => {
                                if (ok) toast.success("Task removed");
                                else toast.error("Couldn't remove the task");
                              })}
                              aria-label={`Delete "${task.title}"`}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
      </div>

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={async (input) => {
          const ok = await add(input);
          setCreateOpen(false);
          if (ok) toast.success("Task created");
          else toast.error("Couldn't create the task");
        }}
        onReload={reload}
      />
    </div>
  );
}

function CreateTaskDialog({
  open,
  onOpenChange,
  onCreate,
  onReload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    title: string;
    dueAt?: string | null;
    priority: TaskPriority;
    category: string;
    recurrence: TaskRecurrence;
    tags?: string[];
  }) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  const [dueValue, setDueValue] = React.useState("");
  const [priority, setPriority] = React.useState<TaskPriority>("medium");
  const [category, setCategory] = React.useState("Study");
  const [recurrence, setRecurrence] = React.useState<TaskRecurrence>("none");
  const [tags, setTags] = React.useState("");

  const submit = () => {
    if (!title.trim()) return;
    void onCreate({
      title: title.trim(),
      dueAt: dueValue ? new Date(dueValue).toISOString() : null,
      priority,
      category,
      recurrence,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8),
    });
    setTitle("");
    setDueValue("");
    setPriority("medium");
    setCategory("Study");
    setRecurrence("none");
    setTags("");
    void onReload();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>Add something to your list.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              placeholder="e.g. Revise Physics Unit 2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due (local time)</Label>
              <Input
                id="task-due"
                type="datetime-local"
                value={dueValue}
                onChange={(event) => setDueValue(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as TaskPriority)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Repeats</Label>
              <Select value={recurrence} onValueChange={(value) => setRecurrence(value as TaskRecurrence)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">One-off</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Study", "Assignment", "Personal"].map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-tags">Tags (comma separated, optional)</Label>
            <Input
              id="task-tags"
              placeholder="physics, revision"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!title.trim()}>
            Add task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}