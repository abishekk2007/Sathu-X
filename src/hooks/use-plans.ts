"use client";

import * as React from "react";

import type { ClientPlan, ClientPlanStep, StepStatus } from "@/types";

export interface PlanStepInput {
  title: string;
  description?: string | null;
  estimatedMinutes?: number | null;
  taskId?: string | null;
}

export interface PlanInput {
  title?: string;
  objective: string;
  description?: string | null;
  steps: PlanStepInput[];
}

interface PlansState {
  plans: ClientPlan[];
  loading: boolean;
  error: string | null;
}

/** API access for the /plans view (RLS-owner-scoped, no user id ever sent). */
export function usePlans() {
  const [state, setState] = React.useState<PlansState>({
    plans: [],
    loading: true,
    error: null,
  });

  const load = React.useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch("/api/plans", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as { plans: ClientPlan[] };
      setState({ plans: data.plans ?? [], loading: false, error: null });
    } catch {
      setState({ plans: [], loading: false, error: "unable_to_load" });
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const create = React.useCallback(
    async (input: PlanInput): Promise<ClientPlan | null> => {
      try {
        const response = await fetch("/api/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as { plan: ClientPlan; steps: ClientPlanStep[] };
        setState((previous) => ({
          ...previous,
          plans: [data.plan, ...previous.plans],
        }));
        return data.plan;
      } catch {
        return null;
      }
    },
    []
  );

  const update = React.useCallback(
    async (id: string, patch: { title?: string; objective?: string; status?: ClientPlan["status"] }): Promise<boolean> => {
      try {
        const response = await fetch(`/api/plans/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { plan: ClientPlan };
        setState((previous) => ({
          ...previous,
          plans: previous.plans.map((plan) => (plan.id === id ? data.plan : plan)),
        }));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const remove = React.useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/plans/${id}`, { method: "DELETE" });
      if (!response.ok) return false;
      setState((previous) => ({
        ...previous,
        plans: previous.plans.filter((plan) => plan.id !== id),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Loads a single plan's steps (called by the view; cached per id). */
  const stepsFor = React.useCallback(
    async (planId: string): Promise<ClientPlanStep[]> => {
      try {
        const response = await fetch(`/api/plans/${planId}`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return [];
        const data = (await response.json()) as { plan: ClientPlan; steps: ClientPlanStep[] };
        return data.steps ?? [];
      } catch {
        return [];
      }
    },
    []
  );

  const setStepStatus = React.useCallback(
    async (planId: string, stepId: string, status: StepStatus): Promise<boolean> => {
      try {
        const response = await fetch(`/api/plans/${planId}/steps/${stepId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
    []
  );

  return {
    plans: state.plans,
    loading: state.loading,
    error: state.error,
    reload: load,
    create,
    update,
    remove,
    stepsFor,
    setStepStatus,
  };
}