"use client";

import * as React from "react";
import { ClipboardPasteIcon, Loader2Icon } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";

interface PasteTextDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, content: string) => Promise<{ ok: boolean; error?: string }>;
}

export function PasteTextDialog({
  open,
  onOpenChange,
  onSave,
}: PasteTextDialogProps) {
  const [name, setName] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      setError("Please paste some text.");
      return;
    }
    setSaving(true);
    setError(null);
    const result = await onSave(name.trim() || "Pasted notes", trimmed);
    setSaving(false);
    if (result.ok) {
      setName("");
      setContent("");
      setError(null);
      onOpenChange(false);
    } else {
      setError(result.error ?? "Failed to save");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPasteIcon className="size-4" />
            Paste text
          </DialogTitle>
          <DialogDescription>
            Paste study material, question banks, notes, or any text to use as context.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            placeholder="Name (optional — e.g. DBMS Question Bank)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            autoFocus
          />
          <Textarea
            placeholder="Paste your text here..."
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              if (error) setError(null);
            }}
            rows={10}
            className="resize-y text-sm"
          />
          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !content.trim()}>
            {saving ? (
              <>
                <Loader2Icon className="mr-1 size-3 animate-spin" />
                Saving...
              </>
            ) : (
              "Save as context"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
