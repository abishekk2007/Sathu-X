"use client";

import { CheckIcon, CopyIcon, MapPinIcon, MoreHorizontalIcon } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildGoogleMapsSearchLink } from "@/lib/location";
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
        {message.userImage ? (
          // Phase 7E — camera capture attached to this user message. The
          // data URL is an app-owned, normalized still (never remote content).
          <div className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.userImage.dataUrl}
              alt={message.userImage.name || "Camera photo"}
              className="max-h-40 rounded-lg object-cover"
            />
          </div>
        ) : null}
        <p className="whitespace-pre-wrap">{message.content}</p>
        {message.userLocation ? (
          // Phase 7F — coarse shared location marker. The link is an
          // app-built Google Maps search pin; raw coords are never shown.
          <a
            href={buildGoogleMapsSearchLink(message.userLocation)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open approximate shared location in Google Maps"
            className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[11px] font-medium text-primary-foreground/90 transition-colors hover:bg-primary-foreground/25"
          >
            <MapPinIcon className="size-3" />
            Shared location
          </a>
        ) : null}
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
