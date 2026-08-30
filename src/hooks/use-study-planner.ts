"use client";

import * as React from "react";

import type {
  ExamRecord,
  StudyDashboardData,
  StudyGoalRecord,
  StudyPlanRecord,
  StudySessionRecord,
} from "@/types";
import { toDateOnly } from "@/lib/study-planner";

export interface ExamInput {
  title: string;
  examDate: string;
  subjectId?: string | null;
  examType?: string | null;
  description?: string | null;
  targetScore?: number | null;
  priority?: number | null;
}

export interface GoalInput {
  title: string;
  description?: string | null;
  targetDate?: string | null;
  targetMinutes?: number | null;
}

export interface GeneratePlanInput {
  name?: string;
  examId?: string | null;
  startDate?: string;
  endDate?: string;
  dailyMinutes?: number;
  preferredDays?: number[];
  preferredTime?: string | null;
  subjectIds?: string[];
  /** Regeneration: patch this plan (requires replaceFutureSessions). */
  planId?: string;
  replaceFutureSessions?: boolean;
}

interface AsyncState<T> {
  data: T;
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

/** The client's local date anchors all server-side day grouping. */
function todayIso(): string {
  return toDateOnly(new Date());
}

/**
 * Phase 4C planner data access: study dashboard, exams, plans, sessions and
 * goals. Ownership is enforced server-side; this hook never sends a user id.
 */
export function useStudyPlanner() {
  // Stable ref so any action can refresh sessions without a circular
  // useCallback dependency (the loader itself is declared further down).
  const loadSessionsRef = React.useRef<
    (window?: { from: string; to: string }) => Promise<boolean>
  >(async () => false);

  // ---- Dashboard ----------------------------------------------------------
  const [study, setStudy] = React.useState<AsyncState<StudyDashboardData | null>>({
    data: null,
    loading: true,
    error: null,
  });

  const loadStudyDashboard = React.useCallback(async () => {
    setStudy((previous) => ({ ...previous, loading: true, error: null }));
    const result = await requestJson<StudyDashboardData>(
      `/api/student/study-dashboard?today=${todayIso()}`
    );
    if (result.ok) {
      setStudy({ data: result.data, loading: false, error: null });
    } else {
      setStudy((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadStudyDashboard();
    });
  }, [loadStudyDashboard]);

  // ---- Exams --------------------------------------------------------------
  const [exams, setExams] = React.useState<AsyncState<ExamRecord[]>>({
    data: [],
    loading: true,
    error: null,
  });

  const loadExams = React.useCallback(async () => {
    setExams((previous) => ({ ...previous, loading: true, error: null }));
    const result = await requestJson<{ exams: ExamRecord[] }>("/api/exams");
    if (result.ok) {
      setExams({ data: result.data.exams ?? [], loading: false, error: null });
    } else {
      setExams((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadExams();
    });
  }, [loadExams]);

  const addExam = React.useCallback(
    async (input: ExamInput): Promise<boolean> => {
      const result = await requestJson<{ exam: ExamRecord }>("/api/exams", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!result.ok) return false;
      void loadExams();
      void loadStudyDashboard();
      return true;
    },
    [loadExams, loadStudyDashboard]
  );

  const updateExam = React.useCallback(
    async (id: string, patch: Partial<ExamInput> & { status?: string }) => {
      const result = await requestJson<{ exam: ExamRecord }>(`/api/exams/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!result.ok) return false;
      void loadExams();
      void loadStudyDashboard();
      return true;
    },
    [loadExams, loadStudyDashboard]
  );

  const deleteExam = React.useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/exams/${id}`, { method: "DELETE" }).catch(
        () => null
      );
      if (!response || !response.ok) return false;
      void loadExams();
      void loadStudyDashboard();
      return true;
    },
    [loadExams, loadStudyDashboard]
  );

  // ---- Plans ----------------------------------------------------------------
  const [plans, setPlans] = React.useState<AsyncState<StudyPlanRecord[]>>({
    data: [],
    loading: true,
    error: null,
  });

  const loadPlans = React.useCallback(async () => {
    setPlans((previous) => ({ ...previous, loading: true, error: null }));
    const result = await requestJson<{ plans: StudyPlanRecord[] }>(
      "/api/study-plans"
    );
    if (result.ok) {
      setPlans({ data: result.data.plans ?? [], loading: false, error: null });
    } else {
      setPlans((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadPlans();
    });
  }, [loadPlans]);

  const generatePlan = React.useCallback(
    async (
      input: GeneratePlanInput
    ): Promise<
      | { ok: true; source: "ai" | "fallback"; sessions: StudySessionRecord[] }
      | { ok: false; status: number }
    > => {
      const result = await requestJson<{
        plan: StudyPlanRecord;
        sessions: StudySessionRecord[];
        source: "ai" | "fallback";
      }>("/api/study-plans/generate", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          today: todayIso(),
          replaceFutureSessions:
            input.planId !== undefined ? true : undefined,
        }),
      });
      if (!result.ok) return { ok: false, status: result.status };
      void loadPlans();
      void loadSessionsRef.current();
      void loadStudyDashboard();
      return { ok: true, source: result.data.source, sessions: result.data.sessions ?? [] };
    },
    [loadPlans, loadStudyDashboard]
  );

  const deletePlan = React.useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/study-plans/${id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) return false;
      void loadPlans();
      void loadSessionsRef.current();
      void loadStudyDashboard();
      return true;
    },
    [loadPlans, loadStudyDashboard]
  );

  // ---- Sessions (range-backed; refreshed after every mutation) --------------
  const [range, setRange] = React.useState<{ from: string; to: string }>(() => {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    const end = new Date();
    end.setDate(end.getDate() + 21);
    return { from: toDateOnly(start), to: toDateOnly(end) };
  });

  const [sessions, setSessions] = React.useState<AsyncState<StudySessionRecord[]>>({
    data: [],
    loading: true,
    error: null,
  });

  const loadSessions = React.useCallback(
    async (window?: { from: string; to: string }): Promise<boolean> => {
      const active = window ?? range;
      // Remember the requested window so post-mutation refreshes (which go
      // through loadSessionsRef without arguments) re-fetch the same span.
      setRange(active);
      setSessions((previous) => ({ ...previous, loading: true, error: null }));
      const result = await requestJson<{ sessions: StudySessionRecord[] }>(
        `/api/study-sessions?from=${active.from}&to=${active.to}&today=${todayIso()}`
      );
      if (result.ok) {
        setSessions({
          data: result.data.sessions ?? [],
          loading: false,
          error: null,
        });
        return true;
      }
      setSessions((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
      return false;
    },
    [range]
  );

  // Keep the ref pointed at the latest loader on every render.
  React.useEffect(() => {
    loadSessionsRef.current = loadSessions;
  });

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadSessions();
    });
  }, [loadSessions]);

  const changeSessionStatus = React.useCallback(
    async (
      id: string,
      status: "planned" | "completed" | "skipped"
    ): Promise<boolean> => {
      const result = await requestJson<{ session: StudySessionRecord }>(
        `/api/study-sessions/${id}`,
        { method: "PATCH", body: JSON.stringify({ status }) }
      );
      if (!result.ok) return false;
      void loadSessionsRef.current();
      void loadStudyDashboard();
      return true;
    },
    [loadStudyDashboard]
  );

  const updateSession = React.useCallback(
    async (
      id: string,
      patch: {
        scheduledDate?: string;
        startTime?: string | null;
        durationMinutes?: number;
        sessionType?: string;
        notes?: string | null;
      }
    ): Promise<boolean> => {
      const result = await requestJson<{ session: StudySessionRecord }>(
        `/api/study-sessions/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      if (!result.ok) return false;
      void loadSessionsRef.current();
      void loadStudyDashboard();
      return true;
    },
    [loadStudyDashboard]
  );

  const deleteSession = React.useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/study-sessions/${id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) return false;
      void loadSessionsRef.current();
      void loadStudyDashboard();
      return true;
    },
    [loadStudyDashboard]
  );

  // ---- Goals ---------------------------------------------------------------
  const [goals, setGoals] = React.useState<AsyncState<StudyGoalRecord[]>>({
    data: [],
    loading: true,
    error: null,
  });

  const loadGoals = React.useCallback(async () => {
    setGoals((previous) => ({ ...previous, loading: true, error: null }));
    const result = await requestJson<{ goals: StudyGoalRecord[] }>(
      "/api/study-goals"
    );
    if (result.ok) {
      setGoals({ data: result.data.goals ?? [], loading: false, error: null });
    } else {
      setGoals((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadGoals();
    });
  }, [loadGoals]);

  const addGoal = React.useCallback(
    async (input: GoalInput): Promise<boolean> => {
      const result = await requestJson<{ goal: StudyGoalRecord }>(
        "/api/study-goals",
        { method: "POST", body: JSON.stringify(input) }
      );
      if (!result.ok) return false;
      void loadGoals();
      void loadStudyDashboard();
      return true;
    },
    [loadGoals, loadStudyDashboard]
  );

  const updateGoal = React.useCallback(
    async (
      id: string,
      patch: Partial<GoalInput> & { status?: string }
    ): Promise<boolean> => {
      const result = await requestJson<{ goal: StudyGoalRecord }>(
        `/api/study-goals/${id}`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      if (!result.ok) return false;
      void loadGoals();
      void loadStudyDashboard();
      return true;
    },
    [loadGoals, loadStudyDashboard]
  );

  const deleteGoal = React.useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/study-goals/${id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) return false;
      void loadGoals();
      void loadStudyDashboard();
      return true;
    },
    [loadGoals, loadStudyDashboard]
  );

  return {
    study: study.data,
    studyLoading: study.loading,
    studyError: study.error,
    reloadStudy: loadStudyDashboard,

    exams: exams.data,
    examsLoading: exams.loading,
    examsError: exams.error,
    reloadExams: loadExams,
    addExam,
    updateExam,
    deleteExam,

    plans: plans.data,
    plansLoading: plans.loading,
    plansError: plans.error,
    reloadPlans: loadPlans,
    generatePlan,
    deletePlan,

    range,
    setRange,
    sessions: sessions.data,
    sessionsLoading: sessions.loading,
    sessionsError: sessions.error,
    reloadSessions: loadSessions,
    changeSessionStatus,
    updateSession,
    deleteSession,

    goals: goals.data,
    goalsLoading: goals.loading,
    goalsError: goals.error,
    reloadGoals: loadGoals,
    addGoal,
    updateGoal,
    deleteGoal,
  };
}
