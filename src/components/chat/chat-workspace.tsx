"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  MoreHorizontalIcon,
  PanelLeftIcon,
  SearchIcon,
  ShareIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { AssistantMessage } from "@/components/chat/assistant-message";
import { ChatComposer } from "@/components/chat/chat-composer";
import type { AttachedSource } from "@/components/chat/chat-composer";
import { ChatContextSelector } from "@/components/chat/chat-context-selector";
import { ChatStudyIndicator } from "@/components/chat/chat-study-indicator";
import { ConversationPanel } from "@/components/chat/conversation-panel";
import { EmptyChatState } from "@/components/chat/empty-chat-state";
import { ThinkingIndicator } from "@/components/chat/thinking-indicator";
import { UserMessage } from "@/components/chat/user-message";
import { useChatStudyTracking } from "@/hooks/use-chat-study-tracking";
import { useCommandPalette } from "@/components/layout/command-palette";
import { NotificationsPopover } from "@/components/layout/notifications-popover";
import { mockModes } from "@/data/mock";
import {
  conversationGroupFromUpdatedAt,
  type DbConversationRow,
  type DbMessageRow,
} from "@/lib/supabase/types";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { publishConversations } from "@/lib/conversation-store";
import type {
  AiMode,
  ChatContextSelection,
  ChatImageAttachment,
  ChatImageContextItem,
  ChatMessage,
  Conversation,
} from "@/types";
import { cn } from "@/lib/utils";

function nowLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Lightweight client-side hint for the thinking copy — the server owns the
 * real IMAGE_GENERATION decision; this only picks a nicer loading label. */
const IMAGE_THINK_RE =
  /^(?:draw|paint|sketch|render|generate|make|create|design|illustrate|imagine|visualize|draft|compose)\b/i;

/** Phase 6D — edit/regeneration lead verbs for the thinking label. */
const IMAGE_EDIT_THINK_RE =
  /^(?:edit|modify|change|alter|transform|restyle|recolor|recolour|re-imagine|reimagine|recreate|re-create|redo|re-do|remake|regenerate|re-generate|make\s+it|make\s+the|make\s+this|change\s+the|turn\s+the|set\s+the|adjust|update|revise|redraw|re-draw)\b/i;

function isAwaitingImage(messages: ChatMessage[], index: number) {
  const prior = messages[index - 1];
  if (!prior || prior.role !== "user") return false;
  return IMAGE_THINK_RE.test(prior.content.trim());
}

/**
 * Phase 6D — cosmetic thinking label for edit turns: a prior edit-style
 * message AND an existing rendered image in the conversation. Cosmetic only —
 * the server owns the real IMAGE_EDIT decision.
 */
function isAwaitingImageEdit(messages: ChatMessage[], index: number) {
  const prior = messages[index - 1];
  if (!prior || prior.role !== "user") return false;
  const hasImage = messages
    .slice(0, index)
    .some((m) => m.role === "assistant" && Boolean(m.image));
  if (!hasImage) return false;
  return IMAGE_EDIT_THINK_RE.test(prior.content.trim());
}

/**
 * Phase 6D — gathers rendered assistant images as METADATA (keys + prompts +
 * dims; never the base64 bytes) so a follow-up like "make the sky sunset" can
 * be routed as an EDIT of an existing image. Keys are stable per message id.
 */
function collectImageContext(messages: ChatMessage[]): ChatImageContextItem[] {
  const items: ChatImageContextItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.image) continue;
    items.push({
      key: `img-${message.id}`,
      provider: message.image.provider,
      mimeType: message.image.mimeType,
      prompt: message.image.prompt,
      width: message.image.width,
      height: message.image.height,
    });
  }
  return items;
}

/** How many recent turns are sent as context to Gemini. */
const CONTEXT_WINDOW = 20;

/** Deterministic chat title from the first user message (no AI involved). */
function titleFromFirstMessage(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || "New conversation";
}

function dbConversationToUi(row: DbConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    group: conversationGroupFromUpdatedAt(row.updated_at),
    messages: [],
    updatedAt: row.updated_at,
  };
}

function dbMessageToUi(row: DbMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    timeLabel: new Date(row.created_at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    }),
    status: "complete",
  };
}

function sortConversations(items: Conversation[]) {
  return [...items].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
  );
}

function MessageListSkeleton() {
  return (
    <div
      className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6"
      aria-busy="true"
      aria-label="Loading messages"
    >
      <Skeleton className="ml-auto h-10 w-2/5 rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="ml-auto h-10 w-1/3 rounded-xl" />
      <Skeleton className="h-16 w-11/12 rounded-xl" />
    </div>
  );
}

export function ChatWorkspace() {
  const searchParams = useSearchParams();
  const { setOpen: setPaletteOpen } = useCommandPalette();

  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [messagesById, setMessagesById] = React.useState<
    Record<string, ChatMessage[]>
    >({});
  const [loadingConversations, setLoadingConversations] =
    React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [loadingMessages, setLoadingMessages] = React.useState(false);
  const [feedback, setFeedback] = React.useState<
    Record<string, "up" | "down">
  >({});
  const [mode, setMode] = React.useState<AiMode>("general");
  // Optional academic context (Phase 4B): subject/topic chosen before chatting.
  const [contextSelection, setContextSelection] =
    React.useState<ChatContextSelection>({});
  const [failNext, setFailNext] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [attachedSources, setAttachedSources] = React.useState<AttachedSource[]>([]);

  // Resolved after the first conversations load so ?c=<id> can be validated.
  const [activeId, setActiveId] = React.useState<string | null>(null);

  // ---- Chat study time tracking (Phase 4D Enhancement) --------------------
  const {
    status: studyStatus,
    activeSeconds: studyActiveSeconds,
    markActivity: markStudyActivity,
  } = useChatStudyTracking({
    mode: mode === "student" ? "student" : mode,
    subjectId: contextSelection.subjectId ?? null,
    topicId: contextSelection.topicId ?? null,
    conversationId: activeId,
  });

  const demoTimer = React.useRef<number | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  /** Conversation ids whose messages are already cached in messagesById. */
  const loadedIdsRef = React.useRef<Set<string>>(new Set());
  /** Live content of the in-flight stream, for persisting on Stop. */
  const streamingRef = React.useRef<{
    conversationId: string;
    messageId: string;
    content: string;
  } | null>(null);
  /** Re-entry guard so rapid sends can't create duplicate conversations. */
  const sendingRef = React.useRef(false);

  React.useEffect(() => {
    return () => {
      if (demoTimer.current) window.clearTimeout(demoTimer.current);
      abortRef.current?.abort();
    };
  }, []);

  const activeMessages = React.useMemo(
    () => (activeId ? (messagesById[activeId] ?? []) : []),
    [activeId, messagesById]
  );

  const lastMessage = activeMessages[activeMessages.length - 1];
  const isBusy = activeMessages.some(
    (m) => m.status === "thinking" || m.status === "streaming"
  );

  // Keep the newest message in view while it streams.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeMessages, lastMessage?.content.length]);

  /** Moves an active conversation to the top of the sidebar (activity bump). */
  const touchConversation = React.useCallback((id: string) => {
    setConversations((items) =>
      sortConversations(
        items.map((conversation) =>
          conversation.id === id
            ? { ...conversation, updatedAt: new Date().toISOString(), group: "today" }
            : conversation
        )
      )
    );
  }, []);

  /** Saves a user turn; returns false when RLS/network rejects it. */
  const persistUserMessage = React.useCallback(
    async (conversationId: string, message: ChatMessage) => {
      const { error } = await getSupabaseBrowserClient()
        .from("messages")
        .insert({
          id: message.id,
          conversation_id: conversationId,
          role: message.role,
          content: message.content,
        });
      if (error) {
        console.error("Failed to save user message:", error.message);
        return false;
      }
      return true;
    },
    []
  );

  /**
   * Saves/updates an assistant turn. Regeneration reuses the same row id,
   * so a plain upsert keeps the DB aligned with what's on screen.
   */
  const saveAssistantMessage = React.useCallback(
    async (conversationId: string, message: ChatMessage) => {
      const { error } = await getSupabaseBrowserClient()
        .from("messages")
        .upsert(
          {
            id: message.id,
            conversation_id: conversationId,
            role: "assistant",
            content: message.content,
          },
          { onConflict: "id" }
        );
      if (error) {
        console.error("Failed to save assistant message:", error.message);
        toast.error("Reply could not be saved.");
        return;
      }
      touchConversation(conversationId);
    },
    [touchConversation]
  );

  /** Loads persisted messages for a conversation once, caching by id. */
  const loadMessages = React.useCallback(async (id: string) => {
    if (loadedIdsRef.current.has(id)) return;
    loadedIdsRef.current.add(id);
    setLoadingMessages(true);
    try {
      const { data, error } = await getSupabaseBrowserClient()
        .from("messages")
        .select("id,conversation_id,role,content,created_at")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true })
        .limit(100);
      if (error) throw error;
      const messages = (data ?? []).map(dbMessageToUi);
      setMessagesById((byId) => ({ ...byId, [id]: messages }));
    } catch (error) {
      loadedIdsRef.current.delete(id);
      console.error("Failed to load messages:", error);
      toast.error("Could not load this chat's messages.");
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  /** Sidebar selection: switch + lazily hydrate messages + sync mode. */
  const selectConversation = React.useCallback(
    (id: string) => {
      setActiveId(id);
      const match = conversations.find((conversation) => conversation.id === id);
      if (match) setMode(match.mode);
      void loadMessages(id);
    },
    [conversations, loadMessages]
  );

  /**
   * Loads the sidebar list for the signed-in user (RLS scopes rows to them).
   * Awaits before touching state so effect callers run zero synchronous
   * setState; loading therefore ALWAYS terminates, including under React
   * StrictMode's dev double-mount. Retry reuses this exact path.
   */
  const loadConversations = React.useCallback(async (retryCount = 0) => {
    await Promise.resolve();

    setLoadingConversations(true);
    setLoadError(false);

    const { data, error } = await getSupabaseBrowserClient()
      .from("conversations")
      .select("id,title,mode,created_at,updated_at")
      .order("updated_at", { ascending: false })
      .limit(100);

    if (error) {
      if (
        (error.message.includes("JWT") || error.message.includes("future")) &&
        retryCount < 1
      ) {
        console.warn("[chat-workspace] JWT error detected. Refreshing session and retrying...");
        const { error: refreshError } = await getSupabaseBrowserClient().auth.refreshSession();
        if (!refreshError) {
          return loadConversations(retryCount + 1);
        }
        console.error("[chat-workspace] Session refresh failed:", refreshError.message);
      }
      setLoadingConversations(false);
      console.error("Failed to load conversations:", error.message);
      setLoadError(true);
      return;
    }
    
    setLoadingConversations(false);
    setConversations(sortConversations((data ?? []).map(dbConversationToUi)));
  }, []);

  /** Latest selectConversation for use inside stable callbacks. */
  const selectConversationRef = React.useRef(selectConversation);
  selectConversationRef.current = selectConversation;

  /**
   * Selection helpers that keep the URL authoritative: ?c=<id> while a
   * conversation is open, ?new=1 (or no param) for New Chat. replaceState
   * keeps back/forward and refresh working without extra navigations.
   */
  const openConversation = React.useCallback(
    (id: string) => {
      selectConversation(id);
      window.history.replaceState(null, "", `/chat?c=${encodeURIComponent(id)}`);
    },
    [selectConversation]
  );

  const startNewChat = React.useCallback(() => {
    // Pure UI state — NO database row until the first message is sent.
    setActiveId(null);
    window.history.replaceState(null, "", "/chat?new=1");
  }, []);

  /**
   * Keeps selection in sync with the URL so sidebar "+"/deep links/back-forward
   * all behave identically, and a refresh reopens the same conversation.
   */
  React.useEffect(() => {
    if (loadingConversations) return;

    if (searchParams.get("new") === "1") {
      if (activeId !== null) queueMicrotask(() => setActiveId(null));
      return;
    }

    const requested = searchParams.get("c");
    if (!requested || requested === activeId) return;
    if (!conversations.some((c) => c.id === requested)) return;
    queueMicrotask(() => selectConversationRef.current(requested));
  }, [searchParams, loadingConversations, activeId, conversations]);

  // Initial sidebar load (retryable via the panel's Retry action).
  React.useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadConversations();
    });
    return () => {
      cancelled = true;
    };
  }, [loadConversations]);

  // Mirror loaded conversations for other client consumers (command palette).
  React.useEffect(() => {
    publishConversations(conversations);
  }, [conversations]);

  const updateMessage = React.useCallback(
    (conversationId: string, messageId: string, patch: Partial<ChatMessage>) => {
      setMessagesById((byId) => ({
        ...byId,
        [conversationId]: (byId[conversationId] ?? []).map((message) =>
          message.id === messageId ? { ...message, ...patch } : message
        ),
      }));
    },
    []
  );

  const cancelPendingWork = () => {
    if (demoTimer.current) {
      window.clearTimeout(demoTimer.current);
      demoTimer.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  };

  /** Streams a real Gemini response into an existing assistant message slot. */
  const runCompletion = React.useCallback(
    async (
      conversationId: string,
      messageId: string,
      history: ChatMessage[]
    ) => {
      updateMessage(conversationId, messageId, {
        status: "thinking",
        content: "",
      });

      if (failNext) {
        demoTimer.current = window.setTimeout(() => {
          demoTimer.current = null;
          updateMessage(conversationId, messageId, { status: "error" });
        }, 700);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      streamingRef.current = { conversationId, messageId, content: "" };

      try {
        const windowed = history.slice(-CONTEXT_WINDOW);
        // Phase 6D — image metadata + bytes for the edit source (the most
        // recent rendered image). Bytes travel ONCE per request, never
        // duplicated across message history.
        const imageContext = collectImageContext(windowed);
        const lastImageMessage = [...windowed]
          .reverse()
          .find((m) => m.role === "assistant" && m.image);

        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: windowed.map(({ role, content }) => ({ role, content })),
            mode,
            // Phase 6G — the client's IANA zone so task due-phrases resolve
            // against the user's wall clock instead of the server's.
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            context:
              contextSelection.subjectId || contextSelection.topicId || contextSelection.documentId || attachedSources.length > 0
                ? {
                    ...contextSelection,
                    sourceIds: attachedSources.length > 0
                      ? attachedSources.map((s) => s.id)
                      : contextSelection.sourceIds,
                  }
                : undefined,
            images: imageContext.length > 0 ? imageContext : undefined,
            editImage: lastImageMessage?.image
              ? {
                  sourceKey: `img-${lastImageMessage.id}`,
                  dataUrl: lastImageMessage.image.dataUrl,
                  mimeType: lastImageMessage.image.mimeType,
                }
              : undefined,
          }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          updateMessage(conversationId, messageId, { status: "error" });
          return;
        }

        // Phase 6C: image turns are answered with a single JSON image_message
        // instead of a text stream — detect it before touching the body reader.
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json()) as {
            type?: string;
            message?: string;
            image?: ChatImageAttachment;
          };
          if (payload.type === "image_message") {
            const imageMessage: ChatMessage = {
              id: messageId,
              role: "assistant",
              content: payload.message ?? "",
              timeLabel: nowLabel(),
              status: "complete",
              ...(payload.image ? { image: payload.image } : {}),
            };
            updateMessage(conversationId, messageId, {
              content: imageMessage.content,
              status: "complete",
              image: payload.image,
            });
            await saveAssistantMessage(conversationId, imageMessage);
            markStudyActivity();
            return;
          }
          // Unknown JSON shape — never stream garbage into a message.
          updateMessage(conversationId, messageId, { status: "error" });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let received = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
          streamingRef.current.content = received;
          updateMessage(conversationId, messageId, {
            content: received,
            status: "streaming",
          });
        }

        received += decoder.decode();

        if (received) {
          updateMessage(conversationId, messageId, {
            content: received,
            status: "complete",
          });
          await saveAssistantMessage(conversationId, {
            id: messageId,
            role: "assistant",
            content: received,
            timeLabel: nowLabel(),
            status: "complete",
          });
          // Notify chat study tracker that the assistant replied.
          markStudyActivity();
        } else {
          updateMessage(conversationId, messageId, { status: "error" });
        }
      } catch (error) {
        // Stop button already finalised the message — don't overwrite it.
        if (!controller.signal.aborted) {
          console.error("Chat request failed:", error);
          updateMessage(conversationId, messageId, { status: "error" });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (streamingRef.current?.messageId === messageId) {
          streamingRef.current = null;
        }
      }
    },
    [attachedSources, contextSelection, failNext, mode, saveAssistantMessage, updateMessage, markStudyActivity]
  );

  const appendAssistantTurn = (
    conversationId: string,
    history: ChatMessage[],
    existingMessageId?: string
  ) => {
    const messageId = existingMessageId ?? crypto.randomUUID();
    if (!existingMessageId) {
      setMessagesById((byId) => ({
        ...byId,
        [conversationId]: [
          ...(byId[conversationId] ?? []),
          {
            id: messageId,
            role: "assistant",
            content: "",
            timeLabel: nowLabel(),
            status: "thinking",
          },
        ],
      }));
    }
    void runCompletion(conversationId, messageId, history);
  };

  const handleSend = async (text: string) => {
    if (sendingRef.current || !text.trim()) return;
    sendingRef.current = true;

    try {
      let conversationId = activeId;
      const knownConversation =
        !!conversationId && conversations.some((c) => c.id === conversationId);

      // A conversation row is created exactly when its first message is sent.
      if (!knownConversation) {
        const { data, error } = await getSupabaseBrowserClient()
          .from("conversations")
          .insert({ title: titleFromFirstMessage(text), mode })
          .select("id,title,mode,created_at,updated_at")
          .single();
        if (error || !data) {
          console.error(
            "Failed to create conversation:",
            error?.message ?? "no row returned"
          );
          toast.error("Could not start a new chat. Please try again.");
          return;
        }
        const row = data as DbConversationRow;
        conversationId = row.id;
        setConversations((items) =>
          sortConversations([dbConversationToUi(row), ...items])
        );
        setActiveId(conversationId);
        window.history.replaceState(
          null,
          "",
          `/chat?c=${encodeURIComponent(row.id)}`
        );
      }

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timeLabel: nowLabel(),
      };

      const targetId = conversationId as string;
      const history = [...(messagesById[targetId] ?? []), userMessage];

      loadedIdsRef.current.add(targetId);
      setMessagesById((byId) => ({
        ...byId,
        [targetId]: history,
      }));

      // Persist the user turn BEFORE spending Gemini quota on the reply.
      const saved = await persistUserMessage(targetId, userMessage);
      if (!saved) {
        setMessagesById((byId) => ({
          ...byId,
          [targetId]: (byId[targetId] ?? []).filter(
            (message) => message.id !== userMessage.id
          ),
        }));
        toast.error("Message could not be saved.");
        return;
      }

      touchConversation(targetId);
      appendAssistantTurn(targetId, history);
      // Notify chat study tracker of activity.
      markStudyActivity();
    } finally {
      sendingRef.current = false;
    }
  };

  const handleStop = () => {
    cancelPendingWork();
    if (!activeId) return;

    const streaming = streamingRef.current;
    const wasStreamingHere = streaming?.conversationId === activeId;
    const finalContent = wasStreamingHere ? streaming.content : null;

    const finalized = (messagesById[activeId] ?? []).map((message) => {
      if (message.role !== "assistant" || message.status === "complete") {
        return message;
      }
      if (
        wasStreamingHere &&
        streaming.messageId === message.id &&
        finalContent
      ) {
        return { ...message, content: finalContent, status: "complete" as const };
      }
      return {
        ...message,
        status: message.content ? ("complete" as const) : ("error" as const),
      };
    });

    setMessagesById((byId) => ({ ...byId, [activeId]: finalized }));

    if (wasStreamingHere && finalContent && streaming.messageId) {
      const stopped = finalized.find((m) => m.id === streaming.messageId);
      if (stopped && stopped.status === "complete") {
        void saveAssistantMessage(activeId, stopped);
      }
    }
  };

  const handleRegenerate = (messageId: string) => {
    if (!activeId) return;
    const history = messagesById[activeId] ?? [];
    const index = history.findIndex((m) => m.id === messageId);
    if (index === -1) return;
    // Context is everything before the answer being regenerated; the last
    // entry is always the user turn being answered.
    const context = history.slice(0, index);
    if (!context.length || context[context.length - 1].role !== "user") return;
    cancelPendingWork();
    runCompletion(activeId, messageId, context);
  };

  const handleFeedback = (messageId: string, value: "up" | "down") => {
    setFeedback((current) => ({ ...current, [messageId]: value }));
    toast.success(value === "up" ? "Thanks for the feedback!" : "Noted — I'll improve.");
  };

  const handleRename = (id: string, title: string) => {
    const clean = title.trim();
    if (!clean) return;
    setConversations((items) =>
      items.map((conversation) =>
        conversation.id === id ? { ...conversation, title: clean } : conversation
      )
    );
    void (async () => {
      const { error } = await getSupabaseBrowserClient()
        .from("conversations")
        .update({ title: clean })
        .eq("id", id);
      if (error) {
        console.error("Failed to rename conversation:", error.message);
        toast.error("Rename could not be saved.");
        return;
      }
      toast.success("Chat renamed");
    })();
  };

  const handleDelete = (id: string) => {
    cancelPendingWork();
    setConversations((items) => items.filter((conversation) => conversation.id !== id));
    setMessagesById((byId) => {
      const next = { ...byId };
      delete next[id];
      return next;
    });
    loadedIdsRef.current.delete(id);
    if (streamingRef.current?.conversationId === id) streamingRef.current = null;
    if (activeId === id) setActiveId(null);
    // Cascade delete removes the conversation's messages server-side.
    void (async () => {
      const { error } = await getSupabaseBrowserClient()
        .from("conversations")
        .delete()
        .eq("id", id);
      if (error) {
        console.error("Failed to delete conversation:", error.message);
        toast.error("Chat could not be deleted.");
        return;
      }
      toast.success("Chat deleted");
    })();
  };

  /** Persists the mode onto the active conversation (local-only otherwise). */
  const changeMode = (value: AiMode) => {
    setMode(value);
    const isActiveKnown =
      !!activeId && conversations.some((c) => c.id === activeId);
    if (!isActiveKnown) return;
    void (async () => {
      const { error } = await getSupabaseBrowserClient()
        .from("conversations")
        .update({ mode: value })
        .eq("id", activeId);
      if (error) {
        console.error("Failed to save mode:", error.message);
        toast.error("Mode change could not be saved.");
      }
    })();
  };

  const activeConversation = conversations.find((c) => c.id === activeId);

  const conversationPanel = (
    <ConversationPanel
      conversations={conversations}
      activeId={activeId}
      isLoading={loadingConversations}
      loadError={loadError}
      onRetryLoad={() => void loadConversations()}
      onSelect={(id) => {
        openConversation(id);
        setPanelOpen(false);
      }}
      onNewChat={() => {
        startNewChat();
        setPanelOpen(false);
      }}
      onRename={handleRename}
      onDelete={handleDelete}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Desktop conversations panel */}
      <aside className="hidden w-72 shrink-0 border-r lg:block">
        {conversationPanel}
      </aside>

      {/* Mobile conversations sheet */}
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="left" className="w-80 gap-0 p-0" aria-describedby={undefined}>
          <SheetHeader className="sr-only">
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          {conversationPanel}
        </SheetContent>
      </Sheet>

      <section aria-label="Chat" className="flex min-w-0 flex-1 flex-col">
        {/* Chat header */}
        <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-3 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Show conversations"
            onClick={() => setPanelOpen(true)}
          >
            <PanelLeftIcon />
          </Button>
          <h1 className="min-w-0 truncate text-sm font-medium sm:text-[15px]">
            {activeConversation ? activeConversation.title : "New chat"}
          </h1>

          <div
            role="radiogroup"
            aria-label="AI mode"
            className="mx-auto hidden items-center rounded-lg bg-muted p-0.5 md:flex"
          >
            {mockModes.map((item) => (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={mode === item.value}
                onClick={() => changeMode(item.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors text-muted-foreground hover:text-foreground",
                  mode === item.value && "bg-background text-foreground shadow-sm"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-0.5 md:ml-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Search"
                  onClick={() => setPaletteOpen(true)}
                >
                  <SearchIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search · Ctrl K</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Share conversation"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(window.location.href)
                      .catch(() => undefined);
                    toast.success("Share link copied");
                  }}
                >
                  <ShareIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Share</TooltipContent>
            </Tooltip>
            <NotificationsPopover />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More options">
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {activeConversation ? (
                  <>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => handleDelete(activeConversation.id)}
                    >
                      <Trash2Icon />
                      Delete chat
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuCheckboxItem
                  checked={failNext}
                  onCheckedChange={(checked) => setFailNext(checked === true)}
                >
                  Simulate error (demo)
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Messages */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim">
          {loadingMessages && activeMessages.length === 0 ? (
            <MessageListSkeleton />
          ) : activeMessages.length === 0 ? (
            <div className="flex min-h-full items-center justify-center">
              <EmptyChatState
                onPick={(prompt) => {
                  if (isBusy) return;
                  handleSend(prompt);
                }}
              />
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
              {activeMessages.map((message, index) => {
                if (message.status === "error") {
                  return (
                    <div
                      key={message.id}
                      className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-center"
                      role="alert"
                    >
                      <p className="text-sm font-medium text-destructive">
                        Something went wrong.
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        The response could not be generated.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => handleRegenerate(message.id)}
                      >
                        Try again
                      </Button>
                    </div>
                  );
                }
                return message.role === "user" ? (
                  <UserMessage key={message.id} message={message} />
                ) : message.status === "thinking" ? (
                  <ThinkingIndicator
                    key={message.id}
                    label={
                      isAwaitingImageEdit(activeMessages, index)
                        ? "Spidey Bot is editing the image"
                        : isAwaitingImage(activeMessages, index)
                          ? "Spidey Bot is generating an image"
                          : undefined
                    }
                  />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    message={message}
                    feedback={feedback[message.id]}
                    onFeedback={(value) => handleFeedback(message.id, value)}
                    onRegenerate={() => handleRegenerate(message.id)}
                  />
                );
              })}
              <div ref={bottomRef} aria-hidden="true" />
            </div>
          )}
        </div>

        <ChatContextSelector
          value={contextSelection}
          onChange={setContextSelection}
        />

        <ChatStudyIndicator
          status={studyStatus}
          activeSeconds={studyActiveSeconds}
          subjectName={mode === "student" ? "Studying" : null}
        />

        <ChatComposer
          key={activeId ?? "new"}
          disabled={isBusy || loadingMessages}
          streaming={isBusy}
          mode={mode}
          onModeChange={changeMode}
          onSend={handleSend}
          onStop={handleStop}
          attachedSources={attachedSources}
          onSourcesChange={setAttachedSources}
        />
      </section>
    </div>
  );
}
