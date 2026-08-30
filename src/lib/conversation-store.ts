import type { Conversation } from "@/types";

/**
 * Tiny module-level mirror of ChatWorkspace's loaded conversations so other
 * client components (command palette) can search REAL chats without a full
 * context/state redesign. ChatWorkspace publishes; consumers read/subscribe.
 */

/**
 * Stable empty snapshot. useSyncExternalStore's getServerSnapshot must return
 * a cached reference — allocating a fresh [] per call triggers React's
 * "getServerSnapshot should be cached" infinite-loop warning.
 */
export const EMPTY_CONVERSATIONS: Conversation[] = [];

let current: Conversation[] = EMPTY_CONVERSATIONS;

const listeners = new Set<() => void>();

export function publishConversations(conversations: Conversation[]) {
  // Same reference = no data change; keep the snapshot stable and skip
  // notifying subscribers.
  if (conversations === current) return;
  current = conversations;
  listeners.forEach((notify) => notify());
}

export function getPublishedConversations(): Conversation[] {
  // Returns the cached array reference — identical until the next publish.
  return current;
}

export function subscribeToConversations(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
