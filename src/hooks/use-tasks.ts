"use client";

import * as React from "react";

import type {
  ClientTask,
  TaskPriority,
  TaskRecurrence,
  TaskStatus,
} from "@/types";

export interface TaskInput {
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  category?: string;
  dueAt?: string | null;
  recurrence?: TaskRecurrence;
  tags?: string[];
}

interface TasksState {
  tasks: ClientTask[];
  loading: boolean;
  error: string | null;
}

/**
 * CRUD access to the signed-in user's tasks via /api/tasks.
 * Ownership is enforced server-side; this hook never sends a user id and
 * never includes cancelled/failed rows in the board buckets.
 */
export function useTasks() {
  const [state, setState] = React.useState<TasksState>({
    tasks: [],
    loading: true,
    error: null,
  });

  const load = React.useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch("/api/tasks", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as { tasks: ClientTask[] };
      setState({ tasks: data.tasks ?? [], loading: false, error: null });
    } catch {
      setState({ tasks: [], loading: false, error: "unable_to_load" });
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const add = React.useCallback(
    async (input: TaskInput): Promise<boolean> => {
      try {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok && response.status !== 201) return false;
        const data = (await response.json()) as { task: ClientTask };
        setState((previous) => ({
          ...previous,
          tasks: [data.task, ...previous.tasks],
        }));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const update = React.useCallback(
    async (
      id: string,
      patch: Partial<TaskInput> & { status?: TaskStatus }
    ): Promise<boolean> => {
      try {
        const response = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { task: ClientTask };
        setState((previous) => ({
          ...previous,
          tasks: previous.tasks.map((task) => (task.id === id ? data.task : task)),
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
      const response = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!response.ok) return false;
      setState((previous) => ({
        ...previous,
        tasks: previous.tasks.filter((task) => task.id !== id),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return {
    tasks: state.tasks,
    loading: state.loading,
    error: state.error,
    reload: load,
    add,
    update,
    remove,
  };
}