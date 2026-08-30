"use client";

import * as React from "react";
import { CheckIcon, CopyIcon, RefreshCwIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { MarkdownContent } from "@/components/chat/markdown-content";
import type { ChatMessage } from "@/types";

interface AssistantMessageProps {
  message: ChatMessage;
  feedback?: "up" | "down";
  onFeedback: (value: "up" | "down") => void;
  onRegenerate?: () => void;
}

function ActionButton({
  label,
  active,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; active?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      className={active ? "text-primary" : "text-muted-foreground"}
      {...props}
    />
  );
}

export function AssistantMessage({
  message,
  feedback,
  onFeedback,
  onRegenerate,
}: AssistantMessageProps) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      toast.success("Response copied");
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <article
      aria-label="Spidey Bot response"
      className="group/msg flex gap-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {message.image ? (
          // Phase 6C: the image arrived as a server-validated data URL inside
          // the JSON image_message — render it directly from that payload.
          <figure className="space-y-1.5">
            {/* next/image can't ingest an inline validated data URL without a
                loader; the ephemeral, user-generated image renders best as an
                unoptimized <img> straight from the server payload. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.image.dataUrl}
              alt={message.content || "Generated image"}
              className="max-h-[480px] w-full max-w-2xl rounded-xl border bg-muted object-contain"
            />
            {message.image.prompt ? (
              <figcaption className="text-xs text-muted-foreground">
                {message.image.provider === "gemini" ? "Gemini" : "Hugging Face"} · {message.image.prompt}
              </figcaption>
            ) : null}
            {message.image.sourceGrounded ? (
              <figcaption className="text-xs text-muted-foreground">
                Based on your document · {message.image.visualType ?? "visual"}
              </figcaption>
            ) : null}
          </figure>
        ) : null}
        <MarkdownContent content={message.content} />
        {message.status === "complete" ? (
          <div className="-ml-2 flex items-center gap-0.5 pt-1 opacity-60 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 hover:opacity-100">
            <ActionButton label="Copy response" onClick={copy}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </ActionButton>
            {onRegenerate ? (
              <ActionButton label="Regenerate response" onClick={onRegenerate}>
                <RefreshCwIcon />
              </ActionButton>
            ) : null}
            <ActionButton
              label="Good response"
              active={feedback === "up"}
              onClick={() => onFeedback("up")}
            >
              <ThumbsUpIcon />
            </ActionButton>
            <ActionButton
              label="Bad response"
              active={feedback === "down"}
              onClick={() => onFeedback("down")}
            >
              <ThumbsDownIcon />
            </ActionButton>
          </div>
        ) : null}
      </div>
    </article>
  );
}
