"use client";

import * as React from "react";

import type { AiMode, ProfileRecord } from "@/types";

export interface ProfilePatch {
  fullName?: string;
  bio?: string;
  college?: string;
  course?: string;
  year?: string;
  preferredMode?: AiMode;
  department?: string;
  semester?: string;
  academicGoal?: string;
  learningStyle?: string;
  preferredLanguage?: string;
  targetScore?: string;
}

interface ProfileState {
  profile: ProfileRecord | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads and updates the signed-in user's profile through /api/profile.
 * The identity always comes from the server session — this hook never sends
 * a user id.
 */
export function useProfile() {
  const [state, setState] = React.useState<ProfileState>({
    profile: null,
    loading: true,
    error: null,
  });

  const load = React.useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch("/api/profile", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as { profile: ProfileRecord };
      setState({ profile: data.profile, loading: false, error: null });
    } catch {
      setState({ profile: null, loading: false, error: "unable_to_load" });
    }
  }, []);

  React.useEffect(() => {
    // Deferred so no setState runs synchronously inside the effect body
    // (StrictMode-safe, same pattern as the sidebar loader).
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const save = React.useCallback(
    async (patch: ProfilePatch): Promise<{ ok: boolean }> => {
      try {
        const response = await fetch("/api/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return { ok: false };
        const data = (await response.json()) as { profile: ProfileRecord };
        setState({ profile: data.profile, loading: false, error: null });
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    []
  );

  return { profile: state.profile, loading: state.loading, error: state.error, reload: load, save };
}
