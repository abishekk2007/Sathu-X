"use client";

import * as React from "react";

import type { StudyFlashcard } from "@/types";
import { toDateOnly } from "@/lib/study-planner";

export interface FlashcardInput {
  question: string;
  answer: string;
  subjectId?: string | null;
}

interface FlashcardsState {
  flashcards: StudyFlashcard[];
  total: number;
  due: number;
  loading: boolean;
  error: string | null;
}

/** Client's local date so "due today" matches the user's calendar. */
function todayIso(): string {
  return toDateOnly(new Date());
}

/**
 * Study flashcard data access for the Practice deck. Ownership is enforced
 * server-side (RLS + auth) — this hook never sends a user id.
 */
export function useFlashcards() {
  const [state, setState] = React.useState<FlashcardsState>({
    flashcards: [],
    total: 0,
    due: 0,
    loading: true,
    error: null,
  });

  const load = React.useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await fetch(
        `/api/flashcards?today=${todayIso()}&limit=200`,
        { headers: { Accept: "application/json" } }
      );
      if (!response.ok) throw new Error("request_failed");
      const data = (await response.json()) as {
        flashcards?: StudyFlashcard[];
        total?: number;
        due?: number;
      };
      setState({
        flashcards: data.flashcards ?? [],
        total: data.total ?? 0,
        due: data.due ?? 0,
        loading: false,
        error: null,
      });
    } catch {
      setState((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const addFlashcard = React.useCallback(
    async (input: FlashcardInput): Promise<boolean> => {
      try {
        const response = await fetch("/api/flashcards", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) return false;
        void load();
        return true;
      } catch {
        return false;
      }
    },
    [load]
  );

  const reviewFlashcard = React.useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/flashcards/${id}/review`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return false;
        void load();
        return true;
      } catch {
        return false;
      }
    },
    [load]
  );

  const deleteFlashcard = React.useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/flashcards/${id}`, {
          method: "DELETE",
        });
        if (!response.ok) return false;
        void load();
        return true;
      } catch {
        return false;
      }
    },
    [load]
  );

  const updateFlashcard = React.useCallback(
    async (
      id: string,
      patch: Partial<FlashcardInput>
    ): Promise<boolean> => {
      try {
        const response = await fetch(`/api/flashcards/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return false;
        void load();
        return true;
      } catch {
        return false;
      }
    },
    [load]
  );

  return {
    ...state,
    reload: load,
    addFlashcard,
    reviewFlashcard,
    deleteFlashcard,
    updateFlashcard,
  };
}