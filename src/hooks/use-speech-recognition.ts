"use client";

import * as React from "react";

import { speechErrorMessage } from "@/lib/speech";

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (typeof SR === "function") return SR as unknown as SpeechRecognitionConstructor;
  return null;
}

export interface UseSpeechRecognitionOptions {
  /**
   * Fired inside the recognition event handler whenever a final (non-interim)
   * transcript chunk is produced. Fires before `transcript` state updates, so
   * consumers can append to an editable input. Kept as a ref so the handler
   * always sees the latest callback without re-registering recognition.
   */
  onFinalTranscript?: (text: string) => void;
}

export interface UseSpeechRecognitionReturn {
  /** Whether the browser supports the Web Speech API. */
  isSupported: boolean;
  /** Whether the microphone is actively capturing audio. */
  isListening: boolean;
  /** Finalized transcript since the last recognition session. */
  transcript: string;
  /** Interim (not-yet-finalized) transcript for live preview. */
  interimTranscript: string;
  /** Non-null when an error occurred (e.g. permission denied, network). */
  error: string | null;
  /** Start listening. Requests microphone permission if not yet granted. */
  start: () => void;
  /** Stop listening and finalize any in-progress transcript. */
  stop: () => void;
  /** Abort without producing a transcript and reset state. */
  abort: () => void;
}

/**
 * Browser-native speech-to-text hook using the Web Speech API
 * (SpeechRecognition / webkitSpeechRecognition).
 *
 * Returns a stable API for starting/stopping recognition and reading
 * the transcript. Cleans up all listeners on unmount.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {}
): UseSpeechRecognitionReturn {
  const [isListening, setIsListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [interimTranscript, setInterimTranscript] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Support is detected on the client AFTER the initial hydration render. It
  // starts `false` everywhere (server + first client render) so markup is
  // identical during SSR/hydration; the mount effect flips it to the real
  // value once we know we are on the client. This keeps the voice button
  // deterministic instead of a server/client mismatch.
  const [isSupported, setIsSupported] = React.useState(false);

  const recognitionRef = React.useRef<SpeechRecognitionInstance | null>(null);
  const mountedRef = React.useRef(true);
  const onFinalTranscriptRef = React.useRef(options.onFinalTranscript);

  // Keep the ref in sync with the latest callback without touching refs
  // during render.
  React.useEffect(() => {
    onFinalTranscriptRef.current = options.onFinalTranscript;
  }, [options.onFinalTranscript]);

  // Detect Web Speech API support after hydration. This effect runs only on
  // the client; the first render (and SSR) deterministically report false.
  // The state update is deferred into a timer callback (never a synchronous
  // setState in the effect body) so markup stays identical during hydration
  // and the update happens once we're safely client-side.
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      setIsSupported(getSpeechRecognitionConstructor() !== null);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  // Cleanup on unmount
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.onstart = null;
        rec.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const start = React.useCallback(() => {
    if (!isSupported) {
      setError("Speech recognition is not supported in this browser.");
      return;
    }

    // If already listening, stop first then restart.
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    const SR = getSpeechRecognitionConstructor();
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let finalTranscript = "";

    // Guard: only the CURRENT recognition session may mutate shared state.
    // A stale session (one we aborted to restart) must not clobber the ref or
    // flip `isListening` for the session that replaced it. Without this, the
    // old session's async `onend` fires after a restart and nulls the ref of
    // the live session — leaving the UI stuck and voice input unreliable.
    const isCurrent = () => recognitionRef.current === recognition;

    recognition.onstart = () => {
      if (mountedRef.current && isCurrent()) {
        setIsListening(true);
        setError(null);
        setInterimTranscript("");
      }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let finalized = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          finalized += text;
          finalTranscript += text;
        } else {
          interim += text;
        }
      }
      if (finalized) {
        onFinalTranscriptRef.current?.(finalized);
      }
      if (mountedRef.current && isCurrent()) {
        setTranscript(finalTranscript);
        setInterimTranscript(interim);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "aborted" is expected when we call stop()/abort() — don't surface it.
      if (event.error === "aborted") return;

      const message = speechErrorMessage(event.error);
      if (mountedRef.current && isCurrent()) {
        setError(message);
        setIsListening(false);
        setInterimTranscript("");
        // Drop the dead session so a subsequent start()/stop() never acts on
        // it. onend may not fire after certain errors (no-speech, network),
        // which would otherwise leave a dangling ref.
        recognitionRef.current = null;
      }
    };

    recognition.onend = () => {
      if (mountedRef.current && isCurrent()) {
        setIsListening(false);
        recognitionRef.current = null;
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch {
      if (mountedRef.current) {
        setError("Failed to start speech recognition.");
        setIsListening(false);
      }
      recognitionRef.current = null;
    }
  }, [isSupported]);

  const stop = React.useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.stop();
      // onend fires after stop() completes.
    }
  }, []);

  const abort = React.useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.abort();
      // onend fires after abort() completes.
    }
    if (mountedRef.current) {
      setTranscript("");
      setInterimTranscript("");
      setIsListening(false);
    }
  }, []);

  return {
    isSupported,
    isListening,
    transcript,
    interimTranscript,
    error,
    start,
    stop,
    abort,
  };
}
