"use client";

import * as React from "react";

import type { ChatStudyStatus } from "@/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval between heartbeat requests to the server (ms). */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** After this many ms of no user activity, pause tracking (ms). */
const INACTIVITY_TIMEOUT_MS = 60_000;
/** Time-step for the local active-seconds counter (ms). */
const TICK_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Client-side chat study time tracker.
 *
 * Manages a server-side chat_study_sessions row, counting only active
 * seconds while the tab is visible, the window is focused, and the user
 * is actively interacting. Heartbeats are sent periodically to persist
 * progress and protect against page refresh.
 */
export function useChatStudyTracking({
  mode,
  subjectId,
  topicId,
  conversationId,
}: {
  mode: string;
  subjectId: string | null;
  topicId: string | null;
  conversationId: string | null;
}): {
  status: ChatStudyStatus;
  activeSeconds: number;
  markActivity: () => void;
} {
  const [status, setStatus] = React.useState<ChatStudyStatus>("inactive");
  const [activeSeconds, setActiveSeconds] = React.useState(0);
  const [sessionId, setSessionId] = React.useState<string | null>(null);

  // Refs for stable access inside intervals/timeouts.
  const statusRef = React.useRef<ChatStudyStatus>("inactive");
  const sessionIdRef = React.useRef<string | null>(null);
  const mountedRef = React.useRef(true);
  const lastActivityTimeRef = React.useRef<number>(0);
  const tickTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const inactivityTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs synced with state via effect (render-safe).
  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);
  React.useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // ---- Helpers ------------------------------------------------------------

  const clearAllTimers = React.useCallback(() => {
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
    if (heartbeatTimerRef.current !== null) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (inactivityTimerRef.current !== null) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }, []);

  const patchSession = React.useCallback(
    async (sid: string, patch: { activeSeconds?: number; stop?: boolean }) => {
      try {
        await fetch("/api/student/chat-study-sessions", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ sessionId: sid, ...patch }),
        });
      } catch {
        // Fail-open: heartbeat failures should never break the UX.
      }
    },
    []
  );

  const startSession = React.useCallback(
    async (
      subj: string,
      top: string | null,
      conv: string | null
    ): Promise<string | null> => {
      try {
        const response = await fetch("/api/student/chat-study-sessions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            subjectId: subj,
            topicId: top ?? undefined,
            conversationId: conv ?? undefined,
          }),
        });
        if (!response.ok) return null;
        const data = (await response.json()) as {
          sessionId: string;
          resumed: boolean;
        };
        return data.sessionId ?? null;
      } catch {
        return null;
      }
    },
    []
  );

  // ---- Start / stop / context-change logic --------------------------------

  React.useEffect(() => {
    const hasContext = mode === "student" && !!subjectId;
    if (!hasContext) {
      // No academic context — stop any active session.
      const oldSid = sessionIdRef.current;
      if (oldSid) {
        void patchSession(oldSid, { stop: true });
      }
      clearAllTimers();
      queueMicrotask(() => {
        setStatus("inactive");
        setActiveSeconds(0);
        setSessionId(null);
      });
      return;
    }

    let cancelled = false;

    void (async () => {
      // Stop old session if context changed.
      const oldSid = sessionIdRef.current;
      if (oldSid) {
        await patchSession(oldSid, { stop: true });
      }
      if (cancelled || !mountedRef.current) return;

      const sid = await startSession(subjectId, topicId, conversationId);
      if (cancelled || !mountedRef.current) return;

      if (sid) {
        setSessionId(sid);
        setActiveSeconds(0);
        lastActivityTimeRef.current = Date.now();
        setStatus(document.hidden ? "paused" : "tracking");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, subjectId, topicId, conversationId, startSession, patchSession, clearAllTimers]);

  // ---- Visibility / focus -------------------------------------------------

  React.useEffect(() => {
    const hasContext = mode === "student" && !!subjectId;
    if (!hasContext) return;

    const updateVisibility = () => {
      if (document.hidden) {
        if (statusRef.current === "tracking") {
          setStatus("paused");
        }
      } else {
        lastActivityTimeRef.current = Date.now();
        const sid = sessionIdRef.current;
        if (sid && statusRef.current === "paused") {
          setStatus("tracking");
        }
      }
    };

    const updateFocus = () => {
      if (!document.hasFocus()) {
        if (statusRef.current === "tracking") {
          setStatus("paused");
        }
      } else {
        lastActivityTimeRef.current = Date.now();
        const sid = sessionIdRef.current;
        if (sid && statusRef.current === "paused" && !document.hidden) {
          setStatus("tracking");
        }
      }
    };

    document.addEventListener("visibilitychange", updateVisibility);
    window.addEventListener("focus", updateFocus);
    window.addEventListener("blur", updateFocus);

    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      window.removeEventListener("focus", updateFocus);
      window.removeEventListener("blur", updateFocus);
    };
  }, [mode, subjectId]);

  // ---- Tick (active seconds counter) --------------------------------------

  React.useEffect(() => {
    if (status !== "tracking") {
      if (tickTimerRef.current !== null) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      return;
    }

    tickTimerRef.current = setInterval(() => {
      const now = Date.now();
      const idle = now - lastActivityTimeRef.current;
      if (document.hidden || !document.hasFocus() || idle > INACTIVITY_TIMEOUT_MS) {
        setStatus("paused");
        return;
      }
      setActiveSeconds((prev) => prev + 1);
    }, TICK_INTERVAL_MS);

    return () => {
      if (tickTimerRef.current !== null) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [status]);

  // ---- Heartbeat (periodic server sync) -----------------------------------

  React.useEffect(() => {
    if (status !== "tracking" || !sessionId) {
      if (heartbeatTimerRef.current !== null) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      return;
    }

    const sid = sessionId;
    heartbeatTimerRef.current = setInterval(() => {
      const idle = Date.now() - lastActivityTimeRef.current;
      if (idle > INACTIVITY_TIMEOUT_MS || document.hidden || !document.hasFocus()) {
        return;
      }
      void patchSession(sid, { activeSeconds: HEARTBEAT_INTERVAL_MS / 1000 });
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatTimerRef.current !== null) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };
  }, [status, sessionId, patchSession]);

  // ---- Inactivity timeout -------------------------------------------------

  React.useEffect(() => {
    if (status !== "tracking") {
      if (inactivityTimerRef.current !== null) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      return;
    }

    const sid = sessionId;
    inactivityTimerRef.current = setTimeout(() => {
      if (statusRef.current === "tracking" && sid) {
        void patchSession(sid, { activeSeconds: INACTIVITY_TIMEOUT_MS / 1000 });
        setStatus("paused");
      }
    }, INACTIVITY_TIMEOUT_MS);

    return () => {
      if (inactivityTimerRef.current !== null) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };
  }, [status, sessionId, patchSession]);

  // ---- markActivity (called on user send / assistant response) -----------

  const markActivity = React.useCallback(() => {
    lastActivityTimeRef.current = Date.now();
    const currentStatus = statusRef.current;
    const currentSid = sessionIdRef.current;
    if (currentSid && currentStatus === "paused" && !document.hidden) {
      setStatus("tracking");
    }
  }, []);

  // ---- Cleanup on unmount / navigation -----------------------------------

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAllTimers();
      const sid = sessionIdRef.current;
      if (sid) {
        const elapsed = Math.min((Date.now() - lastActivityTimeRef.current) / 1000, 120);
        void fetch("/api/student/chat-study-sessions", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ sessionId: sid, activeSeconds: elapsed, stop: true }),
        }).catch(() => undefined);
      }
    };
  }, [clearAllTimers]);

  return { status, activeSeconds, markActivity };
}
