"use client";

import * as React from "react";

import type {
  DocumentRecord,
  DocumentFilters,
} from "@/types";

const MAX_SIZE_MB = 25;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
const SUPPORTED_MIME = [
  "application/pdf",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
];

interface DocumentsState {
  documents: DocumentRecord[];
  total: number;
  loading: boolean;
  error: string | null;
  filters: DocumentFilters;
}

interface UseDocumentsReturn {
  documents: DocumentRecord[];
  total: number;
  loading: boolean;
  error: string | null;
  filters: DocumentFilters;
  setFilters: (patch: Partial<DocumentFilters>) => void;
  reload: () => void;
  upload: (
    file: File,
    options?: { name?: string; subjectId?: string | null; topicId?: string | null }
  ) => Promise<{ ok: boolean; error?: string; document?: DocumentRecord }>;
  rename: (id: string, name: string) => Promise<boolean>;
  updateAssociation: (
    id: string,
    patch: { subjectId?: string | null; topicId?: string | null }
  ) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  processDocument: (id: string) => Promise<{ ok: boolean; error?: string }>;
  processingId: string | null;
}

/** Returns true if the file is accepted for upload. */
export function validateFile(
  file: File
): { ok: true } | { ok: false; error: string } {
  if (!SUPPORTED_MIME.includes(file.type) && file.size > 0) {
    // Some browsers don't set type for .md — fall back to extension check
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "md" && ext !== "txt" && ext !== "docx" && ext !== "pdf") {
      return {
        ok: false,
        error: "Unsupported file type. Accepted: PDF, DOCX, TXT, MD.",
      };
    }
  }
  if (file.size > MAX_SIZE_BYTES) {
    return {
      ok: false,
      error: `File exceeds the ${MAX_SIZE_MB} MB limit.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, error: "File is empty." };
  }
  return { ok: true };
}

export function useDocuments(): UseDocumentsReturn {
  const [state, setState] = React.useState<DocumentsState>({
    documents: [],
    total: 0,
    loading: true,
    error: null,
    filters: { page: 1, limit: 20 },
  });
  const filtersRef = React.useRef(state.filters);
  React.useEffect(() => {
    filtersRef.current = state.filters;
  });

  const load = React.useCallback(async (filters?: DocumentFilters) => {
    const f = filters ?? filtersRef.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const params = new URLSearchParams();
      if (f.search) params.set("search", f.search);
      if (f.subjectId) params.set("subjectId", f.subjectId);
      if (f.topicId) params.set("topicId", f.topicId);
      if (f.status) params.set("status", f.status);
      params.set("page", String(f.page ?? 1));
      params.set("limit", String(f.limit ?? 20));

      const response = await fetch(`/api/documents?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as {
        documents: DocumentRecord[];
        total: number;
        page: number;
        limit: number;
      };
      setState({
        documents: data.documents ?? [],
        total: data.total ?? 0,
        loading: false,
        error: null,
        filters: f,
      });
    } catch {
      setState((previous) => ({
        ...previous,
        loading: false,
        error: "unable_to_load",
      }));
    }
  }, []);

  React.useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const setFilters = React.useCallback(
    (patch: Partial<DocumentFilters>) => {
      const next = { ...filtersRef.current, ...patch, page: patch.page ?? 1 };
      filtersRef.current = next;
      void load(next);
    },
    [load]
  );

  const upload = React.useCallback(
    async (
      file: File,
      options?: {
        name?: string;
        subjectId?: string | null;
        topicId?: string | null;
      }
    ): Promise<{ ok: boolean; error?: string; document?: DocumentRecord }> => {
      const validation = validateFile(file);
      if (!validation.ok) return { ok: false, error: validation.error };

      const formData = new FormData();
      formData.append("file", file);
      if (options?.name) formData.append("name", options.name);
      if (options?.subjectId) formData.append("subjectId", options.subjectId);
      if (options?.topicId) formData.append("topicId", options.topicId);

      try {
        const response = await fetch("/api/documents", {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          return {
            ok: false,
            error: body.error ?? `Upload failed (status ${response.status})`,
          };
        }
        const data = (await response.json()) as { document: DocumentRecord };
        // Add the new document to the top of the list
        setState((previous) => ({
          ...previous,
          documents: [data.document, ...previous.documents],
          total: previous.total + 1,
        }));
        return { ok: true, document: data.document };
      } catch {
        return { ok: false, error: "Network error" };
      }
    },
    []
  );

  const rename = React.useCallback(
    async (id: string, name: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/documents/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { document: DocumentRecord };
        setState((previous) => ({
          ...previous,
          documents: previous.documents.map((d) =>
            d.id === id ? data.document : d
          ),
        }));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const updateAssociation = React.useCallback(
    async (
      id: string,
      patch: { subjectId?: string | null; topicId?: string | null }
    ): Promise<boolean> => {
      try {
        const response = await fetch(`/api/documents/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) return false;
        const data = (await response.json()) as { document: DocumentRecord };
        setState((previous) => ({
          ...previous,
          documents: previous.documents.map((d) =>
            d.id === id ? data.document : d
          ),
        }));
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  const remove = React.useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/documents/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) return false;
      setState((previous) => ({
        ...previous,
        documents: previous.documents.filter((d) => d.id !== id),
        total: previous.total - 1,
      }));
      return true;
    } catch {
      return false;
    }
  }, []);

  const [processingId, setProcessingId] = React.useState<string | null>(null);

  const processDocument = React.useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      setProcessingId(id);
      try {
        const response = await fetch(`/api/documents/${id}/process`, {
          method: "POST",
        });
        const data = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          document?: { processingStatus?: string; extractedTextLength?: number; processedAt?: string };
        };
        if (!response.ok || data.success === false) {
          return { ok: false, error: data.error ?? `Processing failed (status ${response.status})` };
        }
        // Update local state to reflect processing complete
        setState((previous) => ({
          ...previous,
          documents: previous.documents.map((d) =>
            d.id === id
              ? {
                  ...d,
                  processingStatus: "ready" as const,
                  status: "ready" as const,
                  extractedTextLength: data.document?.extractedTextLength ?? null,
                  processedAt: data.document?.processedAt ?? null,
                  processingError: null,
                }
              : d
          ),
        }));
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error" };
      } finally {
        setProcessingId(null);
      }
    },
    []
  );

  return {
    documents: state.documents,
    total: state.total,
    loading: state.loading,
    error: state.error,
    filters: state.filters,
    setFilters,
    reload: () => void load(),
    upload,
    rename,
    updateAssociation,
    remove,
    processDocument,
    processingId,
  };
}
