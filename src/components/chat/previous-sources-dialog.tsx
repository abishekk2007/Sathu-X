"use client";

import * as React from "react";
import { FileTextIcon, ClipboardPasteIcon, CheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ContextSourceRecord, DocumentRecord } from "@/types";

interface PreviousSourcesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recentDocuments: DocumentRecord[];
  recentSources: ContextSourceRecord[];
  onSelect: (ids: string[]) => void;
}

export function PreviousSourcesDialog({
  open,
  onOpenChange,
  recentDocuments,
  recentSources,
  onSelect,
}: PreviousSourcesDialogProps) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selected.size > 0) {
      onSelect(Array.from(selected));
      setSelected(new Set());
      onOpenChange(false);
    }
  };

  const hasItems = recentDocuments.length > 0 || recentSources.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Previous sources</DialogTitle>
          <DialogDescription>
            Select documents or pasted text to attach as context.
          </DialogDescription>
        </DialogHeader>

        {!hasItems ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No previous sources yet. Upload a file or paste text to get started.
          </div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {recentDocuments.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => toggle(doc.id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted ${
                  selected.has(doc.id) ? "bg-muted" : ""
                }`}
              >
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{doc.originalFilename}</span>
                {selected.has(doc.id) && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            ))}
            {recentSources.map((source) => (
              <button
                key={source.id}
                type="button"
                onClick={() => toggle(source.id)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted ${
                  selected.has(source.id) ? "bg-muted" : ""
                }`}
              >
                <ClipboardPasteIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{source.name ?? "Pasted notes"}</span>
                {selected.has(source.id) && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={selected.size === 0}>
            {selected.size > 0 ? (
              `Attach ${selected.size} source${selected.size > 1 ? "s" : ""}`
            ) : (
              "Select sources"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
