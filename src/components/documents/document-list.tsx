"use client";

import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { DocumentCard } from "@/components/documents/document-card";
import type { DocumentRecord } from "@/types";

export function DocumentList({
  documents,
  loading,
  search,
  onView,
  onRename,
  onAssociate,
  onDelete,
  onUploadClick,
}: {
  documents: DocumentRecord[];
  loading: boolean;
  search: string;
  onView: (doc: DocumentRecord) => void;
  onRename: (doc: DocumentRecord) => void;
  onAssociate: (doc: DocumentRecord) => void;
  onDelete: (doc: DocumentRecord) => void;
  onUploadClick: () => void;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-[74px] animate-pulse rounded-xl bg-muted/50"
          />
        ))}
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileTextIcon}
        title={search ? "No documents match your search." : "No documents yet."}
        description={
          search
            ? "Try a different search term."
            : "Upload your study materials to use them with SathuX later."
        }
        action={
          !search ? (
            <Button size="sm" onClick={onUploadClick}>
              Upload document
            </Button>
          ) : undefined
        }
        className="border-solid bg-muted/30"
      />
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {documents.map((doc) => (
        <li key={doc.id}>
          <DocumentCard
            document={doc}
            onView={() => onView(doc)}
            onRename={() => onRename(doc)}
            onAssociate={() => onAssociate(doc)}
            onDelete={() => onDelete(doc)}
          />
        </li>
      ))}
    </ul>
  );
}
