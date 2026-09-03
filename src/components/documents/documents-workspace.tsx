"use client";

import * as React from "react";
import { FileTextIcon, UploadCloudIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { ErrorState } from "@/components/shared/error-state";
import { DocumentList } from "@/components/documents/document-list";
import { DocumentFilters } from "@/components/documents/document-filters";
import { DocumentUploadDialog } from "@/components/documents/document-upload-dialog";
import { DocumentDetailDialog } from "@/components/documents/document-detail-dialog";
import { useDocuments, validateFile } from "@/hooks/use-documents";
import { useStudent } from "@/hooks/use-student";
import type { DocumentRecord } from "@/types";

export function DocumentsWorkspace() {
  const {
    documents,
    total,
    loading,
    error,
    filters,
    setFilters,
    reload,
    upload,
    rename,
    updateAssociation,
    remove,
    processDocument,
    processingId,
  } = useDocuments();
  const { subjects, topicsBySubject, loadTopics } = useStudent();

  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [detailDoc, setDetailDoc] = React.useState<DocumentRecord | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  /** Handles file selection from the hidden input or drop. */
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const result = validateFile(file);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    // Open upload dialog with the file pre-selected by triggering upload directly
    void upload(file).then((r) => {
      if (r.ok) toast.success("Document uploaded.");
      else toast.error(r.error ?? "Upload failed.");
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleDelete = async (doc: DocumentRecord) => {
    const ok = await remove(doc.id);
    if (ok) toast.success("Document deleted.");
    else toast.error("Failed to delete document.");
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => handleFiles(event.target.files)}
      />
      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        <PageHeader
          icon={FileTextIcon}
          title="Your Documents"
          description="Upload study materials to use them with SathuX later."
          actions={
            <Button size="sm" onClick={() => setUploadOpen(true)}>
              <UploadCloudIcon data-icon="inline-start" />
              Upload document
            </Button>
          }
        />

        {/* Dropzone */}
        <button
          type="button"
          onClick={() => setUploadOpen(true)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            handleFiles(event.dataTransfer.files);
          }}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-10 text-center transition-colors focus-visible:border-ring ${
            dragActive
              ? "border-primary bg-primary/5"
              : "border-border hover:bg-muted/40"
          }`}
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <UploadCloudIcon className="size-6" />
          </span>
          <span className="text-sm font-medium">Drop your notes here</span>
          <span className="text-xs text-muted-foreground">
            PDF, DOCX, TXT, MD &middot; up to 25 MB
          </span>
        </button>

        {/* Filters + count */}
        <div className="space-y-3">
          <DocumentFilters
            filters={filters}
            subjects={subjects}
            onChange={setFilters}
          />
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            {loading ? "Loading..." : `${total} document${total === 1 ? "" : "s"}`}
          </h2>
        </div>

        {error ? (
          <ErrorState onRetry={reload} />
        ) : (
          <DocumentList
            documents={documents}
            loading={loading}
            search={filters.search ?? ""}
            onView={(doc) => {
              setDetailDoc(doc);
              setDetailOpen(true);
            }}
            onRename={(doc) => {
              setDetailDoc(doc);
              setDetailOpen(true);
            }}
            onAssociate={(doc) => {
              setDetailDoc(doc);
              setDetailOpen(true);
            }}
            onDelete={handleDelete}
            onUploadClick={() => setUploadOpen(true)}
          />
        )}
      </div>

      <DocumentUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUpload={upload}
        subjects={subjects}
        topicsBySubject={topicsBySubject}
        loadTopics={loadTopics}
      />

      <DocumentDetailDialog
        open={detailOpen}
        document={detailDoc}
        onOpenChange={setDetailOpen}
        onRename={rename}
        onUpdateAssociation={updateAssociation}
        onProcess={processDocument}
        processing={processingId === detailDoc?.id}
        subjects={subjects}
        topicsBySubject={topicsBySubject}
        loadTopics={loadTopics}
      />
    </div>
  );
}
