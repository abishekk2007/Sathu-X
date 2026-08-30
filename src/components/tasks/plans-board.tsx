"use client";

import * as React from "react";
import {
  CheckCircle2Icon,
  CircleIcon,
  FolderKanbanIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { usePlans } from "@/hooks/use-plans";
import type { ClientPlan, ClientPlanStep, PlanStatus, StepStatus } from "@/types";

const planStatusConfig: Record<PlanStatus, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-emerald-500" },
  completed: { label: "Completed", className: "bg-sky-500" },
  cancelled: { label: "Cancelled", className: "bg-red-400" },
};

function PlanStatusDot({ status }: { status: PlanStatus }) {
  const config = planStatusConfig[status];
  if (!config) return null;
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${config.className}`} />
      {config.label}
    </Badge>
  );
}

export function PlansBoard() {
  const { plans, loading, reload, create, remove, stepsFor, setStepStatus } = usePlans();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [activePlan, setActivePlan] = React.useState<ClientPlan | null>(null);
  const [stepsByPlan, setStepsByPlan] = React.useState<Record<string, ClientPlanStep[]>>({});

  const openPlan = async (plan: ClientPlan) => {
    setActivePlan(plan);
    const steps = await stepsFor(plan.id);
    setStepsByPlan((previous) => ({ ...previous, [plan.id]: steps }));
  };

  const stepCount = (plan: ClientPlan) =>
    stepsByPlan[plan.id]?.filter((step) => step.status !== "cancelled").length ?? null;

  const toggleStep = async (planId: string, step: ClientPlanStep) => {
    const next: StepStatus = step.status === "completed" ? "pending" : "completed";
    const ok = await setStepStatus(planId, step.id, next);
    if (!ok) {
      toast.error("Couldn't update the step");
      return;
    }
    setStepsByPlan((previous) => ({
      ...previous,
      [planId]:
        previous[planId]?.map((s) => (s.id === step.id ? { ...s, status: next } : s)) ?? [],
    }));
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={FolderKanbanIcon}
          title="Plans"
          description="Multi-step plans generated for exams, assignments and goals."
          actions={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon data-icon="inline-start" />
              New plan
            </Button>
          }
        />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading your plans…</p>
        ) : plans.length === 0 ? (
          <EmptyState
            icon={FolderKanbanIcon}
            title="No plans yet"
            description="Ask Spidey Bot to make a study plan, or create one below."
            action={
              <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                New plan
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {plans.map((plan) => (
              <Card key={plan.id} className="overflow-hidden">
                <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => void openPlan(plan)}
                    aria-label={`Show steps for ${plan.title}`}
                  >
                    <CardTitle className="text-base">{plan.title}</CardTitle>
                    <CardDescription className="mt-1 line-clamp-2">
                      {plan.objective}
                    </CardDescription>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {stepCount(plan) !== null ? (
                      <Badge variant="secondary" className="font-normal text-muted-foreground">
                        {stepCount(plan)} steps
                      </Badge>
                    ) : null}
                    <PlanStatusDot status={plan.status} />
                  </div>
                </CardHeader>
                <CardContent className="pb-4">
                  {plan.dueAt ? (
                    <p className="text-xs text-muted-foreground">
                      Due {new Date(plan.dueAt).toLocaleString()}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">No due date set</p>
                  )}
                </CardContent>
                {activePlan?.id === plan.id ? (
                  <div className="space-y-1 border-t px-4 py-3">
                    {(stepsByPlan[plan.id] ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No steps yet.</p>
                    ) : (
                      (stepsByPlan[plan.id] ?? []).map((step) => (
                        <div
                          key={step.id}
                          className="flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-muted/40"
                        >
                          <button
                            type="button"
                            onClick={() => void toggleStep(plan.id, step)}
                            aria-label={`Mark "${step.title}" ${step.status === "completed" ? "not done" : "done"}`}
                          >
                            {step.status === "completed" ? (
                              <CheckCircle2Icon className="size-4 text-primary" />
                            ) : (
                              <CircleIcon className="size-4 text-muted-foreground" />
                            )}
                          </button>
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-sm ${
                                step.status === "completed"
                                  ? "text-muted-foreground line-through"
                                  : ""
                              }`}
                            >
                              {step.position}. {step.title}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {step.estimatedMinutes ? `~${step.estimatedMinutes} min` : "no estimate"}
                              {step.dependsOn.length > 0 ? " · after earlier steps" : ""}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label={`Delete "${step.title}"`}
                          >
                            <Trash2Icon className="size-4" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </Card>
            ))}
          </div>
        )}
      </div>

      <CreatePlanDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={create}
        onCreated={async (plan) => {
          setCreateOpen(false);
          if (plan) {
            toast.success("Plan created");
            await reload();
          } else {
            toast.error("Couldn't create the plan");
          }
        }}
      />
    </div>
  );
}

function CreatePlanDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    title?: string;
    objective: string;
    steps: { title: string; description?: string | null; estimatedMinutes?: number | null; taskId?: string | null }[];
  }) => Promise<ClientPlan | null>;
  onCreated: (plan: ClientPlan | null) => Promise<void>;
}) {
  const [title, setTitle] = React.useState("");
  const [objective, setObjective] = React.useState("");

  const submit = () => {
    if (!objective.trim()) return;
    void onCreate({
      title: title.trim() || undefined,
      objective: objective.trim(),
      steps: [],
    })
      .then((plan) => onCreated(plan))
      .finally(() => {
        setTitle("");
        setObjective("");
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New plan</DialogTitle>
          <DialogDescription>
            Start a plan by objective; add steps after creating it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="plan-title">Title (optional)</Label>
            <Input
              id="plan-title"
              placeholder="e.g. Exam prep"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-objective">Objective</Label>
            <Textarea
              id="plan-objective"
              placeholder="e.g. Pass the final Chemistry exam"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!objective.trim()}>
            Create plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}