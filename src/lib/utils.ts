import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "today" / "yesterday" / "3 days ago" for review timestamps. */
export function formatReviewedLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const reviewed = new Date(iso);
  if (Number.isNaN(reviewed.getTime())) return "";

  const startOfDay = (date: Date) => {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const days = Math.round(
    (startOfDay(new Date()).getTime() - startOfDay(reviewed).getTime()) /
      86_400_000
  );
  if (days <= 0) return "reviewed today";
  if (days === 1) return "reviewed yesterday";
  if (days < 30) return `reviewed ${days} days ago`;
  return `reviewed ${reviewed.toLocaleDateString()}`;
}

/** "45m" / "1h" / "1h 30m" for study durations. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
