"use client";

import { CheckIcon, CopyIcon, MoreHorizontalIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatMessage } from "@/types";

export function UserMessage({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      toast.success("Message copied");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <article aria-label="Your message" className="group/msg flex flex-col items-end gap-0.5">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground sm:max-w-[70%]">
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
      <div className="flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
        <span>{message.timeLabel}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Message options"
              className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100"
            >
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              Copy text
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
