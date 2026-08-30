"use client";

import * as React from "react";

import type { MemoryCategory, MemoryRecord, MemoryType } from "@/types";

export interface MemoryInput {
  content: string;
  category: MemoryCategory;
  importance: number;
  /** Phase 6F typed taxonomy (optional in the payload; server derives it). */
  type?: MemoryType;
  enabled?: boolean;
}

interface MemoriesState {
  memories: MemoryRecord[];
  loading: boolean;
  error: string | null;
  /** Phase 6F master switch on the server. */
  enabled: boolean;
}

/**
 * CRUD access to the signed-in user's memories via /api/memories.
 * Ownership is enforced server-side; this hook only ever sends content,
 * category and importance.
 */
export function useMemories() {
  const [state, setState] = React.useState<MemoriesState>({
    memories: [],
    loading: true,
    error: null,
    enabled: true,
  });

  const load = React.useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const [memoriesResponse, stateResponse] = await Promise.all([
        fetch("/api/memories", { headers: { Accept: "application/json" } }),
        fetch("/api/memories/state", { headers: { Accept: "application/json" } }).catch(
          () => null
        ),
      ]);
      if (!memoriesResponse.ok) throw new Error(`status ${memoriesResponse.status}`);
      const data = (await memoriesResponse.json()) as { memories: MemoryRecord[] };
      const stateData = stateResponse?.ok
        ? ((await stateResponse.json()) as { enabled: boolean })
        : null;
      setState({
        memories: data.memories ?? [],
        loading: false,
        error: null,
        enabled: stateData?.enabled ?? true,
      });
    } catch {
      setState({ memories: [], loading: false, error: "unable_to_load", enabled: true });
    }
  }, []);

  React.useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body
    // (StrictMode-safe, same pattern as the sidebar loader).
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const add = React.useCallback(
    async (input: MemoryInput): Promise<boolean | "secrets_not_allowed"> => {
      try {
        const response = await fetch("/api/memories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok && response.status !== 201) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          if (payload?.error === "secrets_not_allowed") return "secrets_not_allowed";
          return false;
        }
        const data = (await response.json()) as { memory: MemoryRecord };
        setState((previous) => ({
          ...previous,
          // Replace any local near-duplicate view of the updated row.
          memories: [
            data.memory,
            ...previous.memories.filter((memory) => memory.id !== data.memory.id),
          ],
        }));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const update = React.useCallback(
    async (id: string, input: MemoryInput): Promise<boolean> => {
      try {
        const response = await fetch(`/api/memories/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { memory: MemoryRecord };
        setState((previous) => ({
          ...previous,
          memories: previous.memories.map((memory) =>
            memory.id === id ? data.memory : memory
          ),
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
      const response = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (!response.ok) return false;
      setState((previous) => ({
        ...previous,
        memories: previous.memories.filter((memory) => memory.id !== id),
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const clearAll = React.useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/memories", { method: "DELETE" });
      if (!response.ok) return false;
      setState((previous) => ({ ...previous, memories: [] }));
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Phase 6F master switch toggle (true = recall/extraction on). */
  const setEnabled = React.useCallback(async (enabled: boolean): Promise<boolean> => {
    try {
      const response = await fetch("/api/memories/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) return false;
      setState((previous) => ({ ...previous, enabled }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return {
    memories: state.memories,
    loading: state.loading,
    error: state.error,
    enabled: state.enabled,
    reload: load,
    add,
    update,
    remove,
    clearAll,
    setEnabled,
  };
}
