import type { AiMode, ConversationGroup } from "@/types";

/**
 * Rows as stored in Supabase (public.conversations / public.messages).
 * Kept separate from the UI types so the existing chat components stay
 * untouched by persistence details.
 */
export interface DbConversationRow {
  id: string;
  user_id?: string;
  title: string;
  mode: AiMode;
  created_at: string;
  updated_at: string;
}

export interface DbMessageRow {
  id: string;
  conversation_id: string;
  user_id?: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

/** Maps an ISO timestamp to the sidebar grouping used by Phase 1 UI. */
export function conversationGroupFromUpdatedAt(
  updatedAtIso: string
): ConversationGroup {
  const updated = new Date(updatedAtIso);
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (updated >= startOfToday) return "today";

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (updated >= startOfYesterday) return "yesterday";

  const startOf7DaysAgo = new Date(startOfToday);
  startOf7DaysAgo.setDate(startOf7DaysAgo.getDate() - 7);
  if (updated >= startOf7DaysAgo) return "previous-7-days";

  return "older";
}
