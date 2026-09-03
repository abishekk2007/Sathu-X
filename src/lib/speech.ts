/**
 * Pure helpers for the Phase 7A voice-input feature.
 *
 * These are deliberately free of DOM/React dependencies so they can be unit
 * tested with `npx tsx` (the project's standalone-test convention) despite the
 * browser-only nature of the Web Speech API.
 */

/** Format elapsed seconds as M:SS. */
export function formatDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Maps a SpeechRecognition error code to a user-friendly message. */
export function speechErrorMessage(error: string): string {
  switch (error) {
    case "not-allowed":
      return "Microphone access was denied. Please allow microphone access in your browser settings and try again.";
    case "network":
      return "Speech recognition network error. Please check your internet connection.";
    case "no-speech":
      return "No speech was detected. Please try again.";
    case "audio-capture":
      return "No microphone was found. Please connect a microphone and try again.";
    case "service-not-allowed":
      return "Speech recognition service is not allowed. Please check your browser settings.";
    default:
      return `Speech recognition error: ${error}`;
  }
}
