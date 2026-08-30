"use client";

import * as React from "react";
import { UploadCloudIcon, XIcon } from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import { validateFile } from "@/hooks/use-documents";
import type { DocumentRecord, SubjectRecord, TopicRecord } from "@/types";

export function DocumentUploadDialog({
  open,
  onOpenChange,
  onUpload,
  subjects,
  topicsBySubject,
  loadTopics,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (
    file: File,
    options?: { name?: string; subjectId?: string | null; topicId?: string | null }
  ) => Promise<{ ok: boolean; error?: string; document?: DocumentRecord }>;
  subjects: SubjectRecord[];
  topicsBySubject: Record<string, TopicRecord[]>;
  loadTopics: (subjectId: string) => Promise<TopicRecord[] | null>;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState("");
  const [subjectId, setSubjectId] = React.useState<string>("__none__");
  const [topicId, setTopicId] = React.useState<string>("__none__");
  const [dragActive, setDragActive] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const topics =
    subjectId !== "__none__" ? (topicsBySubject[subjectId] ?? []) : [];

  // Load topics when subject changes
  React.useEffect(() => {
    if (subjectId !== "__none__") {
      void loadTopics(subjectId);
    }
  }, [subjectId, loadTopics]);

  const reset = () => {
    setFile(null);
    setName("");
    setSubjectId("__none__");
    setTopicId("__none__");
    setProgress(0);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFileSelect = (f: File) => {
    const result = validateFile(f);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  };

  const handleSubmit = async () => {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);

    // Simulate progress (real XHR progress is complex with fetch)
    const timer = setInterval(() => {
      setProgress((p) => Math.min(p + 15, 90));
    }, 200);

    const result = await onUpload(file, {
      name: name || undefined,
      subjectId: subjectId === "__none__" ? undefined : subjectId,
      topicId: topicId === "__none__" ? undefined : topicId,
    });

    clearInterval(timer);
    setProgress(100);

    if (result.ok) {
      toast.success("Document uploaded successfully.");
      handleOpenChange(false);
    } else {
      toast.error(result.error ?? "Upload failed.");
      setProgress(0);
    }
    setUploading(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Document</DialogTitle>
          <DialogDescription>
            Supported formats: PDF, DOCX, TXT, MD &middot; Max {25} MB
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFileSelect(f);
            e.target.value = "";
          }}
        />

        {!file ? (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
              dragActive
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40"
            }`}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <UploadCloudIcon className="size-5" />
            </span>
            <span className="text-sm font-medium">
              Drop a file here or click to browse
            </span>
            <span className="text-xs text-muted-foreground">
              PDF, DOCX, TXT, MD &middot; up to 25 MB
            </span>
          </button>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setFile(null);
                  setName("");
                }}
                disabled={uploading}
              >
                <XIcon />
              </Button>
            </div>

            {uploading && (
              <div className="space-y-1">
                <Progress value={progress} />
                <p className="text-xs text-muted-foreground">Uploading...</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="doc-name">Document name</Label>
              <Input
                id="doc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. DBMS Unit 1 Notes"
                disabled={uploading}
              />
            </div>

            <div className="space-y-2">
              <Label>Subject (optional)</Label>
              <Select
                value={subjectId}
                onValueChange={(v) => {
                  setSubjectId(v);
                  setTopicId("__none__");
                }}
                disabled={uploading}
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

            {subjectId !== "__none__" && topics.length > 0 && (
              <div className="space-y-2">
                <Label>Topic (optional)</Label>
                <Select
                  value={topicId}
                  onValueChange={setTopicId}
                  disabled={uploading}
                >
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
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!file || uploading}>
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
