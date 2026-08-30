"use client";

import * as React from "react";
import {
  FileTextIcon,
  InfoIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { mimeTypeLabel } from "@/lib/documents";
import type {
  DocumentRecord,
  DocumentStatus,
  SubjectRecord,
  TopicRecord,
} from "@/types";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DocumentDetailDialog({
  open,
  document: doc,
  onOpenChange,
  onRename,
  onUpdateAssociation,
  onProcess,
  processing,
  subjects,
  topicsBySubject,
  loadTopics,
}: {
  open: boolean;
  document: DocumentRecord | null;
  onOpenChange: (open: boolean) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onUpdateAssociation: (
    id: string,
    patch: { subjectId?: string | null; topicId?: string | null }
  ) => Promise<boolean>;
  onProcess: (id: string) => Promise<{ ok: boolean; error?: string }>;
  processing: boolean;
  subjects: SubjectRecord[];
  topicsBySubject: Record<string, TopicRecord[]>;
  loadTopics: (subjectId: string) => Promise<TopicRecord[] | null>;
}) {
  const [editName, setEditName] = React.useState("");
  const [editSubjectId, setEditSubjectId] = React.useState<string>("__none__");
  const [editTopicId, setEditTopicId] = React.useState<string>("__none__");
  const [saving, setSaving] = React.useState(false);
  const [tab, setTab] = React.useState<"details" | "edit">("details");

  React.useEffect(() => {
    if (doc) {
      queueMicrotask(() => {
        setEditName(doc.name);
        setEditSubjectId(doc.subjectId ?? "__none__");
        setEditTopicId(doc.topicId ?? "__none__");
        setTab("details");
      });
    }
  }, [doc]);

  const topics =
    editSubjectId !== "__none__"
      ? (topicsBySubject[editSubjectId] ?? [])
      : [];

  React.useEffect(() => {
    if (editSubjectId !== "__none__") {
      void loadTopics(editSubjectId);
    }
  }, [editSubjectId, loadTopics]);

  if (!doc) return null;

  const handleSave = async () => {
    setSaving(true);
    let ok = true;

    if (editName !== doc.name) {
      ok = await onRename(doc.id, editName);
    }

    if (ok) {
      const patch: { subjectId?: string | null; topicId?: string | null } = {};
      const newSubjectId = editSubjectId === "__none__" ? null : editSubjectId;
      const newTopicId = editTopicId === "__none__" ? null : editTopicId;
      if (newSubjectId !== doc.subjectId || newTopicId !== doc.topicId) {
        patch.subjectId = newSubjectId;
        patch.topicId = newTopicId;
        ok = await onUpdateAssociation(doc.id, patch);
      }
    }

    setSaving(false);
    if (ok) {
      toast.success("Document updated.");
      onOpenChange(false);
    } else {
      toast.error("Failed to update document.");
    }
  };

  const handleProcess = async () => {
    const result = await onProcess(doc.id);
    if (result.ok) {
      toast.success("Document processed successfully.");
    } else {
      toast.error(result.error ?? "Processing failed.");
    }
  };

  const canProcess = doc.processingStatus === "pending" || doc.processingStatus === "failed";
  const isReady = doc.processingStatus === "ready";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileTextIcon className="size-4 text-primary" />
            {tab === "details" ? "Document Details" : "Edit Document"}
          </DialogTitle>
          <DialogDescription>{doc.originalFilename}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b">
          <button
            type="button"
            onClick={() => setTab("details")}
            className={`border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === "details"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <InfoIcon className="mr-1 inline size-3.5" />
            Details
          </button>
          <button
            type="button"
            onClick={() => setTab("edit")}
            className={`border-b-2 px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === "edit"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            Edit
          </button>
        </div>

        {tab === "details" ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Name</span>
              <span className="font-medium">{doc.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Type</span>
              <span>{mimeTypeLabel(doc.mimeType)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Size</span>
              <span>{formatFileSize(doc.fileSizeBytes)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <StatusBadge status={doc.status as DocumentStatus} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Processing</span>
              <span className="capitalize">{doc.processingStatus}</span>
            </div>
            {doc.extractedTextLength != null && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Extracted text</span>
                <span>{doc.extractedTextLength.toLocaleString()} chars</span>
              </div>
            )}
            {doc.processedAt && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Processed</span>
                <span>{formatDate(doc.processedAt)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subject</span>
              <span>{doc.subjectName ?? "No subject assigned"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Topic</span>
              <span>{doc.topicName ?? "No topic assigned"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Uploaded</span>
              <span>{formatDate(doc.createdAt)}</span>
            </div>
            {doc.processingError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {doc.processingError}
              </div>
            )}
            {canProcess && (
              <Button
                size="sm"
                onClick={handleProcess}
                disabled={processing}
                className="w-full"
              >
                {processing ? "Processing..." : doc.processingStatus === "failed" ? "Retry Processing" : "Process Document"}
              </Button>
            )}
            {isReady && (
              <p className="text-xs text-muted-foreground/60">
                Document is ready for use in Chat Q&A.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Document name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Subject</Label>
              <Select
                value={editSubjectId}
                onValueChange={(v) => {
                  setEditSubjectId(v);
                  setEditTopicId("__none__");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="No subject" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No subject</SelectItem>
                  {subjects.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {editSubjectId !== "__none__" && topics.length > 0 && (
              <div className="space-y-2">
                <Label>Topic</Label>
                <Select value={editTopicId} onValueChange={setEditTopicId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No topic" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No topic</SelectItem>
                    {topics.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tab === "details" ? "Close" : "Cancel"}
          </Button>
          {tab === "edit" && (
            <Button onClick={handleSave} disabled={saving || !editName.trim()}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
