"use client";

import * as React from "react";
import {
  ArrowLeftIcon,
  CopyIcon,
  FileTextIcon,
  ListChecksIcon,
  MessageSquareIcon,
  SendIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { StatusBadge } from "@/components/shared/status-badge";
import type { SpideyDocument } from "@/types";

/** Future-ready document workspace — preview pane + AI assistant panel. */
export function DocumentViewer({
  document,
  onBack,
  summary,
}: {
  document: SpideyDocument;
  onBack: () => void;
  summary: string[];
}) {
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [thinking, setThinking] = React.useState(false);

  // Demo Q&A — replaced by the document RAG service later.
  const ask = () => {
    if (!question.trim() || thinking) return;
    setThinking(true);
    setAnswer(null);
    window.setTimeout(() => {
      setThinking(false);
      setAnswer(
        `Based on **${document.name}**: this is covered in section 2.3 with two worked examples. The short version — yes, and the notes include a direct derivation you can reuse in exams.`
      );
    }, 1200);
  };

  return (
    <div className="-mx-4 -my-6 sm:-mx-6">
      <div className="flex h-14 items-center gap-2 border-b px-4 sm:px-6">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to all documents"
              onClick={onBack}
            >
              <ArrowLeftIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
        <p className="min-w-0 truncate text-sm font-medium">{document.name}</p>
        <StatusBadge status={document.status} className="ml-auto shrink-0" />
      </div>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_340px]">
        {/* Preview */}
        <div className="min-h-[320px] rounded-xl border bg-card lg:min-h-[480px]">
          <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs text-muted-foreground">
            <FileTextIcon className="size-3.5" />
            Document preview
          </div>
          <div
            aria-hidden="true"
            className="mx-auto my-6 aspect-[1/1.414] w-full max-w-sm rounded-md border bg-background p-6 shadow-inner"
          >
            <div className="space-y-2.5 opacity-40">
              <div className="h-3 w-2/3 rounded bg-foreground/20" />
              <div className="h-2 w-full rounded bg-foreground/10" />
              <div className="h-2 w-11/12 rounded bg-foreground/10" />
              <div className="h-2 w-full rounded bg-foreground/10" />
              <div className="mt-6 h-24 w-full rounded bg-foreground/5" />
              <div className="h-2 w-10/12 rounded bg-foreground/10" />
              <div className="h-2 w-11/12 rounded bg-foreground/10" />
              <div className="h-2 w-9/12 rounded bg-foreground/10" />
            </div>
            <p className="mt-8 text-center text-[10px] text-muted-foreground/60">
              Inline preview renders here once document rendering is connected.
            </p>
          </div>
        </div>

        {/* Assistant panel */}
        <aside
          aria-label="Document assistant"
          className="flex min-h-0 flex-col gap-3 rounded-xl border bg-card p-3"
        >
          <div className="flex items-center gap-2 px-1 pt-1">
            <MessageSquareIcon className="size-4 text-primary" />
            <p className="text-sm font-medium">AI Assistant</p>
          </div>

          <Textarea
            rows={3}
            placeholder="Ask anything about this document..."
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                ask();
              }
            }}
            aria-label="Ask a question about this document"
          />

          {thinking ? (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground" role="status">
              Searching the document…
            </p>
          ) : answer ? (
            <div className="rounded-lg border bg-muted/30 px-3 py-2.5">
              <MarkdownContent content={answer} />
            </div>
          ) : null}

          <Button size="sm" onClick={ask} disabled={!question.trim() || thinking}>
            <SendIcon data-icon="inline-start" />
            Ask document
          </Button>

          <div className="border-t pt-3">
            <p className="flex items-center gap-1.5 px-1 pb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              <ListChecksIcon className="size-3.5" />
              Key points
            </p>
            <ul className="list-disc space-y-1.5 px-5 py-1 text-xs leading-relaxed text-muted-foreground marker:text-primary">
              {summary.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>

          <div className="mt-auto flex gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                void navigator.clipboard
                  .writeText(summary.map((point) => `• ${point}`).join("\n"))
                  .catch(() => undefined);
                toast.success("Key points copied");
              }}
            >
              <CopyIcon data-icon="inline-start" />
              Copy points
            </Button>
            {/* Demo action — saved notes land in Supabase later. */}
            <Button variant="ghost" size="sm" onClick={() => toast.success("Saved to notes (demo)")}>
              Save
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
