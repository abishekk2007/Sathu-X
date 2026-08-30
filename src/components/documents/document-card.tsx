"use client";

import {
  FileTextIcon,
  MoreVerticalIcon,
  PencilIcon,
  Trash2Icon,
  TagIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { mimeTypeLabel } from "@/lib/documents";
import type { DocumentRecord, DocumentStatus } from "@/types";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function DocumentCard({
  document,
  onView,
  onRename,
  onAssociate,
  onDelete,
}: {
  document: DocumentRecord;
  onView: () => void;
  onRename: () => void;
  onAssociate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex h-full items-center gap-3 rounded-xl bg-card p-3.5 ring-1 ring-foreground/10 transition-all hover:-translate-y-0.5 hover:ring-primary/40">
      <button
        type="button"
        onClick={onView}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-label={`View ${document.name}`}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileTextIcon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {document.name}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {mimeTypeLabel(document.mimeType)} &middot;{" "}
            {formatFileSize(document.fileSizeBytes)} &middot;{" "}
            {formatDate(document.createdAt)}
          </span>
          {document.subjectName ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {document.subjectName}
              {document.topicName ? ` / ${document.topicName}` : ""}
            </span>
          ) : (
            <span className="mt-0.5 block text-xs italic text-muted-foreground/60">
              No subject assigned
            </span>
          )}
        </span>
      </button>

      <StatusBadge
        status={document.status as DocumentStatus}
        className="shrink-0"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${document.name}`}
            className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-open:opacity-100"
          >
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onView}>
            <FileTextIcon />
            View details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAssociate}>
            <TagIcon />
            Subject &amp; topic
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
