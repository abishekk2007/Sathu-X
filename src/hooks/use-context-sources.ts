"use client";

import * as React from "react";
import type { ContextSourceRecord, DocumentRecord } from "@/types";

interface UseContextSourcesReturn {
  recentSources: ContextSourceRecord[];
  recentDocuments: DocumentRecord[];
  loading: boolean;
  createPastedText: (name: string, content: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  createImageSource: (file: File) => Promise<{ ok: boolean; id?: string; error?: string }>;
  deleteSource: (id: string) => Promise<boolean>;
  reload: () => void;
}

export function useContextSources(): UseContextSourcesReturn {
  const [recentSources, setRecentSources] = React.useState<ContextSourceRecord[]>([]);
  const [recentDocuments, setRecentDocuments] = React.useState<DocumentRecord[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [sourcesRes, docsRes] = await Promise.all([
        fetch("/api/context-sources?limit=20", { headers: { Accept: "application/json" } }),
        fetch("/api/documents?limit=20", { headers: { Accept: "application/json" } }),
      ]);

      if (sourcesRes.ok) {
        const data = (await sourcesRes.json()) as { sources?: ContextSourceRecord[] };
        setRecentSources(Array.isArray(data.sources) ? data.sources : []);
      }

      if (docsRes.ok) {
        const data = (await docsRes.json()) as { documents?: DocumentRecord[] };
        const docs = Array.isArray(data.documents) ? data.documents : [];
        setRecentDocuments(docs.filter((d) => d.processingStatus === "ready"));
      }
    } catch {
      // Silent fail — UI stays empty
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const createPastedText = React.useCallback(
    async (name: string, content: string): Promise<{ ok: boolean; id?: string; error?: string }> => {
      try {
        const response = await fetch("/api/context-sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "pasted_text", name, content_text: content }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          source?: ContextSourceRecord;
          error?: string;
        };
        if (!response.ok || !data.source) {
          return { ok: false, error: data.error ?? "Failed to save" };
        }
        setRecentSources((prev) => [data.source!, ...prev]);
        return { ok: true, id: data.source.id };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    []
  );

  const createImageSource = React.useCallback(
    async (file: File): Promise<{ ok: boolean; id?: string; error?: string }> => {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("name", file.name);

        const response = await fetch("/api/context-sources", {
          method: "POST",
          body: formData,
        });
        const data = (await response.json().catch(() => ({}))) as {
          source?: ContextSourceRecord;
          error?: string;
        };
        if (!response.ok || !data.source) {
          return { ok: false, error: data.error ?? "Failed to upload image" };
        }
        setRecentSources((prev) => [data.source!, ...prev]);
        return { ok: true, id: data.source.id };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    []
  );

  const deleteSource = React.useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/context-sources/${id}`, { method: "DELETE" });
      if (response.ok) {
        setRecentSources((prev) => prev.filter((s) => s.id !== id));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  return {
    recentSources,
    recentDocuments,
    loading,
    createPastedText,
    createImageSource,
    deleteSource,
    reload: load,
  };
}
