"use client";

import * as React from "react";

interface SpeechSynthesisUtteranceLike extends EventTarget {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onpause: (() => void) | null;
  onresume: (() => void) | null;
}

type SpeechSynthesisUtteranceConstructor = new (text?: string) => SpeechSynthesisUtteranceLike;

/**
 * Resolves the browser speech-synthesis APIs, or null when unavailable.
 * Safe to call at any time; on the server it always returns null.
 */
function resolveSpeechSynthesis(): {
  synthesis: SpeechSynthesis;
  Utterance: SpeechSynthesisUtteranceConstructor;
} | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const synthesis = w.speechSynthesis ?? null;
  const Utterance = w.SpeechSynthesisUtterance ?? null;
  if (!synthesis || typeof Utterance !== "function") return null;
  return {
    synthesis: synthesis as SpeechSynthesis,
    Utterance: Utterance as unknown as SpeechSynthesisUtteranceConstructor,
  };
}

export interface UseSpeechSynthesisOptions {
  /** Milliseconds after an utterance finishes before the native "end" is
   * treated as final. Fires only when a single speaker is active. */
  endDelayMs?: number;
}

export interface SpeechController {
  /** True when the browser supports speech synthesis (client-detected). */
  isSupported: boolean;
  /** True while an assistant response is being spoken. */
  isSpeaking: boolean;
  /** Message id currently being spoken, or null. */
  speakingMessageId: string | null;
  /** Speak `text` for a message. Stops any currently-speaking message first
   * so only one response speaks at a time. No-ops for empty/unsupported. */
  speak: (text: string, messageId: string) => void;
  /** Immediately cancel all speech and clear state. */
  stop: () => void;
}

/**
 * Browser-native text-to-speech hook using `window.speechSynthesis`.
 *
 * Hydration safety: `isSupported` starts `false` on both the server and the
 * first client render (so markup is identical); it is detected only after
 * mount. All speechSynthesis access happens in event handlers / effects, never
 * during render.
 *
 * Single-speaker guarantee: calling `speak()` cancels any in-flight utterance
 * before starting the new one, so two responses never speak at once. Cleanup on
 * unmount cancels speech so nothing continues after the chat is destroyed.
 */
export function useSpeechSynthesis(
  options: UseSpeechSynthesisOptions = {}
): SpeechController {
  const endDelayMs = options.endDelayMs ?? 300;

  const [isSupported, setIsSupported] = React.useState(false);
  const [isSpeaking, setIsSpeaking] = React.useState(false);
  const [speakingMessageId, setSpeakingMessageId] = React.useState<string | null>(null);

  const utteranceRef = React.useRef<SpeechSynthesisUtteranceLike | null>(null);
  const activeMessageIdRef = React.useRef<string | null>(null);
  const endTimerRef = React.useRef<number | null>(null);
  const mountedRef = React.useRef(true);

  // Detect support after hydration (deferred callback, never sync in effect).
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setIsSupported(resolveSpeechSynthesis() !== null);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const clearEndTimer = () => {
    if (endTimerRef.current !== null) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = null;
    }
  };

  const stop = React.useCallback(() => {
    clearEndTimer();
    const current = utteranceRef.current;
    const api = resolveSpeechSynthesis();
    const wasActive = activeMessageIdRef.current !== null;

    if (current) {
      current.onstart = null;
      current.onend = null;
      current.onerror = null;
      current.onpause = null;
      current.onresume = null;
      utteranceRef.current = null;
    }
    if (api) {
      try {
        api.synthesis.cancel();
      } catch {
        // cancel is best-effort; ignore.
      }
    }
    activeMessageIdRef.current = null;
    if (wasActive && mountedRef.current) {
      setIsSpeaking(false);
      setSpeakingMessageId(null);
    }
  }, []);

  // Cleanup on unmount: never leave speech running or stale timers.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearEndTimer();
      const current = utteranceRef.current;
      if (current) {
        current.onstart = null;
        current.onend = null;
        current.onerror = null;
        current.onpause = null;
        current.onresume = null;
        utteranceRef.current = null;
      }
      const api = resolveSpeechSynthesis();
      if (api) {
        try {
          api.synthesis.cancel();
        } catch {
          // best-effort.
        }
      }
    };
  }, []);

  const speak = React.useCallback(
    (text: string, messageId: string) => {
      const speechText = text.replace(/\s+/g, " ").trim();
      if (!speechText) return;

      const api = resolveSpeechSynthesis();
      if (!api) return;

      const { synthesis, Utterance } = api;

      // Single-speaker guarantee: cancel whatever is speaking first.
      try {
        synthesis.cancel();
      } catch {
        // best-effort.
      }
      clearEndTimer();

      let utterance: SpeechSynthesisUtteranceLike;
      try {
        utterance = new Utterance(speechText);
      } catch {
        return;
      }

      utterance.lang = "en-US";
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      utterance.onstart = () => {
        if (!mountedRef.current) return;
        setIsSpeaking(true);
        setSpeakingMessageId(messageId);
      };
      utterance.onend = () => {
        if (!mountedRef.current) return;
        utteranceRef.current = null;
        // Defer so React state settles without synchronous setState-per-event
        // churn; also covers engines that fire end slightly early.
        clearEndTimer();
        endTimerRef.current = window.setTimeout(() => {
          endTimerRef.current = null;
          if (activeMessageIdRef.current === messageId) {
            activeMessageIdRef.current = null;
          }
          if (mountedRef.current) {
            setIsSpeaking(false);
            setSpeakingMessageId(null);
          }
        }, endDelayMs);
      };
      utterance.onerror = (event) => {
        if (!mountedRef.current) return;
        // "interrupted" / "canceled" follow an explicit cancel() — that clean
        // path is handled by stop(); only surface unexpected hardware errors.
        if (event?.error === "interrupted" || event?.error === "canceled") {
          return;
        }
        clearEndTimer();
        utteranceRef.current = null;
        activeMessageIdRef.current = null;
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      };
      utterance.onpause = () => {
        /* reserved for future pause support */
      };
      utterance.onresume = () => {
        /* reserved for future resume support */
      };

      activeMessageIdRef.current = messageId;
      utteranceRef.current = utterance;

      try {
        // The instance comes from the browser's SpeechSynthesisUtterance
        // constructor, so it is a real one at runtime; the cast simply lets
        // TS accept it because we typed the browser handles conservatively.
        synthesis.speak(utterance as unknown as SpeechSynthesisUtterance);
      } catch {
        utteranceRef.current = null;
        activeMessageIdRef.current = null;
        setIsSpeaking(false);
        setSpeakingMessageId(null);
      }
    },
    [endDelayMs]
  );

  return { isSupported, isSpeaking, speakingMessageId, speak, stop };
}
