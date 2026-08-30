"use client";

import * as React from "react";

import type {
  StudentDashboardData,
  SubjectRecord,
  TopicRecord,
  TopicStatus,
} from "@/types";

export interface SubjectInput {
  name: string;
  code?: string | null;
  description?: string | null;
  semester?: string | null;
  credits?: number | null;
  color?: string | null;
}

export interface TopicInput {
  name: string;
  description?: string | null;
  unit?: string | null;
}

interface DashboardState {
  data: StudentDashboardData | null;
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

/**
 * Real student-intelligence data access: the aggregated dashboard plus
 * subject/topic mutations. Ownership is enforced server-side; this hook never
 * sends a user id.
 */
export function useStudent() {
  // ---- Dashboard ----------------------------------------------------------
  const [dashboard, setDashboard] = React.useState<DashboardState>({
    data: null,
    loading: true,
    error: null,
  });

  const loadDashboard = React.useCallback(async () => {
    setDashboard((previous) => ({ ...previous, loading: true, error: null }));
    const result = await requestJson<StudentDashboardData>(
      "/api/student/dashboard"
    );
    if (result.ok) {
      setDashboard({ data: result.data, loading: false, error: null });
    } else {
      setDashboard((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body
    // (StrictMode-safe, same pattern as the sidebar loader).
    queueMicrotask(() => {
      void loadDashboard();
    });
  }, [loadDashboard]);

  // ---- Subjects -----------------------------------------------------------
  const [subjects, setSubjects] = React.useState<SubjectRecord[]>([]);
  const [subjectsLoading, setSubjectsLoading] = React.useState(true);
  const [subjectsError, setSubjectsError] = React.useState<string | null>(null);

  const loadSubjects = React.useCallback(async () => {
    setSubjectsLoading(true);
    setSubjectsError(null);
    const result = await requestJson<{ subjects: SubjectRecord[] }>(
      "/api/subjects?limit=200"
    );
    if (result.ok) {
      setSubjects(result.data.subjects ?? []);
      setSubjectsLoading(false);
    } else {
      setSubjects([]);
      setSubjectsLoading(false);
      setSubjectsError("unable_to_load");
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadSubjects();
    });
  }, [loadSubjects]);

  /** Refreshes dashboard + subject cards after any mutation. */
  const refreshAll = React.useCallback(() => {
    void loadDashboard();
    void loadSubjects();
  }, [loadDashboard, loadSubjects]);

  const addSubject = React.useCallback(
    async (input: SubjectInput): Promise<boolean> => {
      const result = await requestJson<{ subject: SubjectRecord }>(
        "/api/subjects",
        { method: "POST", body: JSON.stringify(input) }
      );
      if (!result.ok) return false;
      refreshAll();
      return true;
    },
    [refreshAll]
  );

  const updateSubject = React.useCallback(
    async (id: string, input: Partial<SubjectInput>): Promise<boolean> => {
      const result = await requestJson<{ subject: SubjectRecord }>(
        `/api/subjects/${id}`,
        { method: "PATCH", body: JSON.stringify(input) }
      );
      if (!result.ok) return false;
      refreshAll();
      return true;
    },
    [refreshAll]
  );

  const deleteSubject = React.useCallback(
    async (id: string): Promise<boolean> => {
      const response = await fetch(`/api/subjects/${id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) return false;
      refreshAll();
      return true;
    },
    [refreshAll]
  );

  // ---- Topics (per selected subject) --------------------------------------
  const [topicsBySubject, setTopicsBySubject] = React.useState<
    Record<string, TopicRecord[]>
  >({});

  const loadTopics = React.useCallback(
    async (subjectId: string): Promise<TopicRecord[] | null> => {
      const result = await requestJson<{ topics: TopicRecord[] }>(
        `/api/subjects/${subjectId}/topics`
      );
      const topics = result.ok ? (result.data.topics ?? []) : null;
      if (topics !== null) {
        setTopicsBySubject((previous) => ({
          ...previous,
          [subjectId]: topics,
        }));
      }
      return topics;
    },
    []
  );

  const addTopic = React.useCallback(
    async (
      subjectId: string,
      input: TopicInput
    ): Promise<{ ok: boolean; conflict?: boolean }> => {
      const result = await requestJson<{ topic: TopicRecord }>(
        `/api/subjects/${subjectId}/topics`,
        { method: "POST", body: JSON.stringify(input) }
      );
      if (!result.ok) {
        return { ok: false, conflict: result.status === 409 };
      }
      await loadTopics(subjectId);
      void loadDashboard();
      return { ok: true };
    },
    [loadTopics, loadDashboard]
  );

  const updateTopic = React.useCallback(
    async (
      topic: Pick<TopicRecord, "id" | "subjectId">,
      patch: {
        name?: string;
        description?: string | null;
        unit?: string | null;
        status?: TopicStatus;
        mastery?: number;
      }
    ): Promise<boolean> => {
      const result = await requestJson<{ topic: TopicRecord }>(
        `/api/topics/${topic.id}`,
        { method: "PATCH", body: JSON.stringify(patch) }
      );
      if (!result.ok) return false;
      await loadTopics(topic.subjectId);
      void loadDashboard();
      return true;
    },
    [loadTopics, loadDashboard]
  );

  const deleteTopic = React.useCallback(
    async (topic: Pick<TopicRecord, "id" | "subjectId">): Promise<boolean> => {
      const response = await fetch(`/api/topics/${topic.id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!response || !response.ok) return false;
      await loadTopics(topic.subjectId);
      void loadDashboard();
      return true;
    },
    [loadTopics, loadDashboard]
  );

  /** Records one practice outcome and refreshes affected views. */
  const recordPractice = React.useCallback(
    async (
      topic: Pick<TopicRecord, "id" | "subjectId">,
      correct: boolean
    ): Promise<
      | {
          ok: true;
          knowledge: {
            attemptCount: number;
            correctCount: number;
            confidenceScore: number;
            strengthScore: number;
          };
          topicMastery: number;
          topicStatus: string;
        }
      | { ok: false }
    > => {
      const result = await requestJson<{
        knowledge: {
          attemptCount: number;
          correctCount: number;
          confidenceScore: number;
          strengthScore: number;
        };
        topicMastery: number;
        topicStatus: string;
      }>("/api/student/practice", {
        method: "POST",
        body: JSON.stringify({ topicId: topic.id, correct }),
      });
      if (!result.ok) return { ok: false };
      await loadTopics(topic.subjectId);
      void loadDashboard();
      return { ok: true, ...result.data };
    },
    [loadTopics, loadDashboard]
  );

  return {
    dashboard: dashboard.data,
    dashboardLoading: dashboard.loading,
    dashboardError: dashboard.error,
    reloadDashboard: loadDashboard,

    subjects,
    subjectsLoading,
    subjectsError,
    reloadSubjects: loadSubjects,
    addSubject,
    updateSubject,
    deleteSubject,

    topicsBySubject,
    loadTopics,
    addTopic,
    updateTopic,
    deleteTopic,
    recordPractice,
  };
}
