"use client";

import * as React from "react";
import {
  MessageSquareIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Conversation, ConversationGroup } from "@/types";
import { cn } from "@/lib/utils";

const groupLabels: Record<ConversationGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "previous-7-days": "Previous 7 Days",
  older: "Older",
};

const groupOrder: ConversationGroup[] = [
  "today",
  "yesterday",
  "previous-7-days",
  "older",
];

export function ConversationPanel({
  conversations,
  activeId,
  isLoading = false,
  loadError = false,
  onRetryLoad,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
}: {
  conversations: Conversation[];
  activeId: string | null;
  isLoading?: boolean;
  loadError?: boolean;
  onRetryLoad?: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const [renameTarget, setRenameTarget] = React.useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const filtered = conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(query.trim().toLowerCase())
  );

  const grouped = groupOrder.map((group) => ({
    group,
    items: filtered.filter((conversation) => conversation.group === group),
  }));

  const isFiltering = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 p-3 pb-2">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 bg-muted/50 pl-8 text-sm"
          />
        </div>
        <Button size="icon-sm" aria-label="New chat" onClick={onNewChat}>
          <PlusIcon />
        </Button>
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto scrollbar-slim px-2 pb-3">
        {isLoading ? (
          <div className="space-y-2 px-1 pt-2" aria-busy="true" aria-label="Loading conversations">
            {[92, 78, 85, 70, 88, 64].map((width, index) => (
              <Skeleton key={index} className="h-9 rounded-lg" style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : loadError ? (
          <div role="alert" className="px-3 py-10 text-center">
            <p className="text-sm font-medium text-destructive">
              Unable to load conversations
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Check your connection and try again.
            </p>
            {onRetryLoad ? (
              <Button variant="outline" size="sm" className="mt-3" onClick={onRetryLoad}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : grouped.every(({ items }) => items.length === 0) ? (
          isFiltering ? (
            <p className="px-2 py-10 text-center text-sm text-muted-foreground">
              No chats match your search.
            </p>
          ) : (
            <div className="px-2 py-10 text-center">
              <p className="text-sm font-medium text-muted-foreground">
                No conversations yet
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground/80">
                Start a new chat to begin.
              </p>
            </div>
          )
        ) : (
          grouped.map(({ group, items }) =>
            items.length === 0 ? null : (
              <section key={group} className="mt-3 first:mt-1">
                <h3 className="px-2 py-1 text-[11px] font-medium tracking-wide text-muted-foreground/80">
                  {groupLabels[group]}
                </h3>
                <ul>
                  {items.map((conversation) => (
                    <li key={conversation.id}>
                      <ConversationRow
                        conversation={conversation}
                        active={conversation.id === activeId}
                        onSelect={() => onSelect(conversation.id)}
                        onRename={() => {
                          setRenameTarget(conversation);
                          setRenameValue(conversation.title);
                        }}
                        onDelete={() => onDelete(conversation.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )
          )
        )}
      </nav>

      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription>Give this conversation a clear name.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameTarget) {
                onRename(renameTarget.id, renameValue.trim() || renameTarget.title);
                setRenameTarget(null);
              }
            }}
            aria-label="Chat title"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() => {
                if (renameTarget) {
                  onRename(renameTarget.id, renameValue.trim());
                  setRenameTarget(null);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const title = conversation.title?.trim() || "New conversation";
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-lg transition-colors hover:bg-muted/70",
        active && "bg-primary/10 hover:bg-primary/15"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2.5 text-left"
      >
        <MessageSquareIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            active && "text-primary"
          )}
        />
        <span
          className={cn(
            "truncate text-sm text-muted-foreground",
            active && "font-medium text-primary"
          )}
        >
          {title}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Options for ${title}`}
            className="mr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-open:opacity-100"
          >
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          <DropdownMenuItem onSelect={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
