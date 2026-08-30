"use client";

import * as React from "react";
import {
  ArrowUpIcon,
  FileTextIcon,
  ClipboardPasteIcon,
  ImageIcon,
  XIcon,
  MicIcon,
  SquareIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { mockModes } from "@/data/mock";
import type { AiMode } from "@/types";
import { cn } from "@/lib/utils";
import { AddContextMenu } from "./add-context-menu";

export interface AttachedSource {
  id: string;
  type: "document" | "pasted_text" | "image";
  name: string;
}

interface ChatComposerProps {
  disabled: boolean;
  streaming: boolean;
  mode: AiMode;
  onModeChange: (mode: AiMode) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  attachedSources?: AttachedSource[];
  onSourcesChange?: (sources: AttachedSource[]) => void;
}

function sourceIcon(type: AttachedSource["type"]) {
  switch (type) {
    case "document":
      return <FileTextIcon className="size-3" />;
    case "pasted_text":
      return <ClipboardPasteIcon className="size-3" />;
    case "image":
      return <ImageIcon className="size-3" />;
  }
}

export function ChatComposer({
  disabled,
  streaming,
  mode,
  onModeChange,
  onSend,
  onStop,
  attachedSources = [],
  onSourcesChange,
}: ChatComposerProps) {
  const [value, setValue] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const removeSource = (id: string) => {
    onSourcesChange?.(attachedSources.filter((s) => s.id !== id));
  };

  const handleSourcesSelected = (sources: AttachedSource[]) => {
    onSourcesChange?.([...attachedSources, ...sources]);
  };

  return (
    <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
      <div className="mx-auto max-w-3xl">
        {/* Attached source chips */}
        {attachedSources.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1">
            {attachedSources.map((source) => (
              <span
                key={source.id}
                className="inline-flex items-center gap-1 rounded-lg bg-primary/10 py-0.5 pr-1 pl-2 text-xs text-primary"
              >
                {sourceIcon(source.type)}
                <span className="max-w-[120px] truncate">{source.name}</span>
                <button
                  type="button"
                  onClick={() => removeSource(source.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
                  aria-label={`Remove ${source.name}`}
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          className={cn(
            "rounded-2xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring/60 focus-within:shadow-md"
          )}
          aria-label="Message composer"
        >
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? "Spidey Bot is thinking..." : "Message Spidey Bot..."}
            disabled={disabled}
            rows={1}
            className="max-h-[180px] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            aria-label="Message Spidey Bot"
          />

          <div className="flex items-center gap-1 px-1 pt-1">
            {/* Add Context button */}
            {onSourcesChange && (
              <AddContextMenu onSourcesSelected={handleSourcesSelected} />
            )}

            {/* Mode selector — synced with the header control */}
            <div
              role="radiogroup"
              aria-label="AI mode"
              className="ml-1 hidden items-center rounded-lg bg-muted p-0.5 min-[420px]:flex"
            >
              {mockModes.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.value}
                  onClick={() => onModeChange(item.value)}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                    mode === item.value &&
                      "bg-background text-foreground shadow-sm"
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-1">
              <span className="mr-1 hidden text-[11px] text-muted-foreground/70 sm:block">
                Enter ↵ · Shift+Enter newline
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Voice input (coming soon)"
                onClick={() => {}}
              >
                <MicIcon />
              </Button>
              {streaming ? (
                <Button size="icon-sm" aria-label="Stop generating" onClick={onStop}>
                  <SquareIcon className="size-3" fill="currentColor" />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  aria-label="Send message"
                  disabled={!value.trim() || disabled}
                  onClick={submit}
                >
                  <ArrowUpIcon />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
          Spidey Bot can make mistakes.
        </p>
      </div>
    </div>
  );
}
