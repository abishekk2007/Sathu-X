"use client";

import * as React from "react";

import type { ProductivityDashboardData, RoutineRecord } from "@/types";

interface ProductivityState {
  data: ProductivityDashboardData | null;
  loading: boolean;
  error: string | null;
}

interface RoutineState {
  data: RoutineRecord | null;
  loading: boolean;
  error: string | null;
}

async function requestJson<T>(
  url: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const response = await fetch(url, {
      headers: init?.body
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      ...init,
    });
    if (!response.ok) return { ok: false, status: response.status };
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, status: 0 };
  }
}

function todayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function useProductivity() {
  // ---- Dashboard ----------------------------------------------------------
  const [dashboard, setDashboard] = React.useState<ProductivityState>({
    data: null,
    loading: true,
    error: null,
  });

  const loadDashboard = React.useCallback(async () => {
    setDashboard((prev) => ({ ...prev, loading: true, error: null }));
    const result = await requestJson<ProductivityDashboardData>(
      `/api/student/productivity?today=${todayIso()}`
    );
    if (result.ok) {
      setDashboard({ data: result.data, loading: false, error: null });
    } else {
      setDashboard((prev) => ({
        ...prev,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadDashboard();
    });
  }, [loadDashboard]);

  // ---- Routine (separate endpoint for PATCH) ------------------------------
  const [routine, setRoutine] = React.useState<RoutineState>({
    data: null,
    loading: true,
    error: null,
  });

  const loadRoutine = React.useCallback(async () => {
    setRoutine((prev) => ({ ...prev, loading: true, error: null }));
    const result = await requestJson<RoutineRecord>("/api/student/routine");
    if (result.ok) {
      setRoutine({ data: result.data, loading: false, error: null });
    } else {
      setRoutine((prev) => ({
        ...prev,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadRoutine();
    });
  }, [loadRoutine]);

  const refreshAll = React.useCallback(() => {
    void loadDashboard();
    void loadRoutine();
  }, [loadDashboard, loadRoutine]);

  const updateRoutine = React.useCallback(
    async (patch: {
      preferredSessionMinutes?: number | null;
      preferredBreakMinutes?: number | null;
      preferredStudyTime?: string | null;
      dailyStudyTargetMinutes?: number | null;
    }): Promise<boolean> => {
      const result = await requestJson<RoutineRecord>("/api/student/routine", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!result.ok) return false;
      setRoutine({ data: result.data, loading: false, error: null });
      void loadDashboard();
      return true;
    },
    [loadDashboard]
  );

  return {
    dashboard: dashboard.data,
    dashboardLoading: dashboard.loading,
    dashboardError: dashboard.error,
    reloadDashboard: loadDashboard,

    routine: routine.data,
    routineLoading: routine.loading,
    routineError: routine.error,
    updateRoutine,

    refreshAll,
  };
}
