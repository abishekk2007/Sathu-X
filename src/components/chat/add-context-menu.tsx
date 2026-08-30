"use client";

import * as React from "react";
import {
  PlusIcon,
  FileUpIcon,
  ClipboardPasteIcon,
  ImageIcon,
  FolderOpenIcon,
  Loader2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PasteTextDialog } from "./paste-text-dialog";
import { PreviousSourcesDialog } from "./previous-sources-dialog";
import { useDocuments } from "@/hooks/use-documents";
import { useContextSources } from "@/hooks/use-context-sources";
import { validateFile } from "@/hooks/use-documents";

interface AddContextMenuProps {
  onSourcesSelected: (sources: Array<{ id: string; type: "document" | "pasted_text" | "image"; name: string }>) => void;
}

export function AddContextMenu({ onSourcesSelected }: AddContextMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [previousOpen, setPreviousOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  const { upload } = useDocuments();
  const {
    recentSources,
    recentDocuments,
    createPastedText,
    createImageSource,
  } = useContextSources();

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  const handleUploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    setOpen(false);

    const validation = validateFile(file);
    if (!validation.ok) {
      toast.error(validation.error);
      return;
    }

    setUploading(true);
    try {
      const result = await upload(file);
      if (result.ok && result.document) {
        toast.success(`${result.document.originalFilename} uploaded — processing...`);
        onSourcesSelected([{
          id: result.document.id,
          type: "document",
          name: result.document.originalFilename,
        }]);
      } else {
        toast.error(result.error ?? "Upload failed");
      }
    } finally {
      setUploading(false);
    }
  };

  const handleUploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    setOpen(false);

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast.error("Image exceeds the 25 MB limit.");
      return;
    }

    setUploading(true);
    try {
      const result = await createImageSource(file);
      if (result.ok && result.id) {
        toast.success(`${file.name} uploaded as context`);
        onSourcesSelected([{
          id: result.id,
          type: "image",
          name: file.name,
        }]);
      } else {
        toast.error(result.error ?? "Failed to upload image");
      }
    } finally {
      setUploading(false);
    }
  };

  const handlePasteSave = async (name: string, content: string) => {
    const result = await createPastedText(name, content);
    if (result.ok && result.id) {
      toast.success("Pasted text added as context");
      onSourcesSelected([{
        id: result.id,
        type: "pasted_text",
        name,
      }]);
      setOpen(false);
    }
    return result;
  };

  const handlePreviousSelect = (ids: string[]) => {
    const sources = ids.map((id) => {
      const doc = recentDocuments.find((d) => d.id === id);
      if (doc) return { id, type: "document" as const, name: doc.originalFilename };
      const src = recentSources.find((s) => s.id === id);
      if (src) return { id, type: src.type as "pasted_text" | "image", name: src.name ?? "Source" };
      return { id, type: "document" as const, name: "Source" };
    });
    onSourcesSelected(sources);
    toast.success(`${sources.length} source${sources.length > 1 ? "s" : ""} attached`);
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.presentationml.document"
        className="hidden"
        onChange={handleUploadFile}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleUploadImage}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label="Add context"
            disabled={uploading}
          >
            {uploading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <PlusIcon className="size-4" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-56 p-1">
          <div className="text-xs font-medium text-muted-foreground px-2 py-1">
            Add context
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              fileInputRef.current?.click();
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <FileUpIcon className="size-4 text-muted-foreground" />
            Upload file
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPasteOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <ClipboardPasteIcon className="size-4 text-muted-foreground" />
            Paste text
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              imageInputRef.current?.click();
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <ImageIcon className="size-4 text-muted-foreground" />
            Add image
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setPreviousOpen(true);
            }}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
          >
            <FolderOpenIcon className="size-4 text-muted-foreground" />
            Previous sources
          </button>
        </PopoverContent>
      </Popover>

      <PasteTextDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        onSave={handlePasteSave}
      />

      <PreviousSourcesDialog
        open={previousOpen}
        onOpenChange={setPreviousOpen}
        recentDocuments={recentDocuments}
        recentSources={recentSources}
        onSelect={handlePreviousSelect}
      />
    </>
  );
}
