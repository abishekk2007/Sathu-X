"use client";

import type { ChatStudyStatus } from "@/types";

/**
 * Small, unobtrusive indicator shown above the chat composer when academic
 * study tracking is active. Displays the current status, subject context,
 * and accumulated active time.
 *
 * Hidden entirely when tracking is inactive (no academic context selected).
 */
export function ChatStudyIndicator({
  status,
  activeSeconds,
  subjectName,
}: {
  status: ChatStudyStatus;
  activeSeconds: number;
  subjectName: string | null;
}) {
  if (status === "inactive") return null;

  const minutes = Math.floor(activeSeconds / 60);
  const seconds = activeSeconds % 60;
  const timeLabel =
    minutes > 0
      ? `${minutes}m ${seconds}s`
      : `${seconds}s`;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-1">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
        <span
          className={`inline-block size-1.5 rounded-full ${
            status === "tracking"
              ? "bg-emerald-500 animate-pulse"
              : "bg-amber-400"
          }`}
          aria-hidden="true"
        />
        {status === "tracking" ? (
          <span>
            {subjectName ?? "Studying"}
            <span className="mx-1">·</span>
            <span className="tabular-nums">{timeLabel} active</span>
          </span>
        ) : (
          <span>Study tracking paused</span>
        )}
      </div>
    </div>
  );
}
