"use client";

import * as React from "react";
import {
  AlarmClockIcon,
  BellIcon,
  CheckCheckIcon,
  FileTextIcon,
  TargetIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { mockNotifications } from "@/data/mock";
import type { NotificationKind } from "@/types";
import { cn } from "@/lib/utils";

const kindIcon: Record<NotificationKind, typeof BellIcon> = {
  reminder: AlarmClockIcon,
  goal: TargetIcon,
  document: FileTextIcon,
};

export function NotificationsPopover({ align = "end" }: { align?: "start" | "end" }) {
  const [notifications, setNotifications] =
    React.useState<typeof mockNotifications>(mockNotifications);
  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
              <BellIcon />
              {unreadCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent align={align} className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2.5">
          <p className="text-sm font-medium">Notifications</p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setNotifications((items) =>
                items.map((item) => ({ ...item, unread: false }))
              );
              toast.success("All notifications marked as read");
            }}
          >
            <CheckCheckIcon data-icon="inline-start" />
            Mark all read
          </Button>
        </div>
        <ul className="max-h-80 overflow-y-auto scrollbar-slim p-1.5">
          {notifications.map((item) => {
            const Icon = kindIcon[item.kind];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    setNotifications((items) =>
                      items.map((n) => (n.id === item.id ? { ...n, unread: false } : n))
                    )
                  }
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-muted/60",
                    item.unread && "bg-primary/5"
                  )}
                >
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{item.title}</span>
                      {item.unread ? (
                        <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {item.body}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground/70">
                      {item.timeLabel}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
