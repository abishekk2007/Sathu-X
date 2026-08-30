"use client";

import * as React from "react";
import {
  BookOpenIcon,
  FileQuestionIcon,
  ListChecksIcon,
  NotebookPenIcon,
  PenLineIcon,
  SparklesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/components/chat/markdown-content";
import { mockToolResults, type StudyTool } from "@/data/mock";

export const toolIcons: Record<StudyTool["icon"], LucideIcon> = {
  notebook: NotebookPenIcon,
  summarize: PenLineIcon,
  quiz: ListChecksIcon,
  exam: FileQuestionIcon,
  explain: BookOpenIcon,
  plan: SparklesIcon,
};

/**
 * Demo tool runner. Fields collect input, Generate simulates a short
 * request, then renders a canned result. Swap `runDemo` for the real
 * study service later without changing the dialog UI.
 */
export function ToolDialog({
  tool,
  open,
  onOpenChange,
}: {
  tool: StudyTool | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden sm:max-w-lg">
        {/* Runner mounts fresh per dialog session so demo state always resets. */}
        {open && tool ? <ToolRunner tool={tool} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ToolRunner({ tool }: { tool: StudyTool }) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const runDemo = () => {
    // Placeholder for the real AI call — simulated with a timer.
    setRunning(true);
    setResult(null);
    timerRef.current = window.setTimeout(() => {
      setRunning(false);
      setResult(mockToolResults[tool.id] ?? "Demo result coming soon.");
    }, 1100);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tool.title}</DialogTitle>
        <DialogDescription>{tool.description}</DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-slim py-1">
        <div className="space-y-3">
          {tool.fields.map((field) => (
            <div key={field.label} className="space-y-1.5">
              <Label>{field.label}</Label>
              {field.kind === "textarea" ? (
                <Textarea
                  rows={4}
                  placeholder={field.placeholder}
                  value={values[field.label] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.label]: event.target.value,
                    }))
                  }
                />
              ) : field.kind === "select" ? (
                <Select
                  value={values[field.label] ?? field.options?.[0]}
                  onValueChange={(value) =>
                    setValues((current) => ({ ...current, [field.label]: value }))
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  placeholder={field.placeholder}
                  value={values[field.label] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.label]: event.target.value,
                    }))
                  }
                />
              )}
            </div>
          ))}
        </div>

        {running ? (
          <div className="space-y-2 rounded-xl border bg-muted/40 p-4" aria-live="polite">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-9/12" />
            <Skeleton className="h-3 w-10/12" />
          </div>
        ) : result ? (
          <div className="rounded-xl border bg-muted/30 p-4" aria-live="polite">
            <MarkdownContent content={result} />
          </div>
        ) : null}
      </div>

      <DialogFooter className="mt-4 items-center gap-2 border-t pt-4 sm:justify-between">
        <p className="text-[11px] text-muted-foreground">
          Demo output — connects to the study engine later.
        </p>
        <div className="flex gap-2">
          {result ? (
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(result).catch(() => undefined);
                toast.success("Result copied");
              }}
            >
              Copy
            </Button>
          ) : null}
          <Button onClick={runDemo} disabled={running}>
            {running ? "Generating..." : tool.cta}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
