"use client";

import { SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DocumentFilters, DocumentStatus, SubjectRecord } from "@/types";

export function DocumentFilters({
  filters,
  subjects,
  onChange,
}: {
  filters: DocumentFilters;
  subjects: SubjectRecord[];
  onChange: (patch: Partial<DocumentFilters>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[180px]">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={filters.search ?? ""}
          onChange={(event) => onChange({ search: event.target.value || undefined })}
          placeholder="Search documents"
          aria-label="Search documents"
          className="h-8 bg-muted/50 pl-8 text-sm"
        />
      </div>

      <Select
        value={filters.subjectId ?? "__all__"}
        onValueChange={(v) =>
          onChange({ subjectId: v === "__all__" ? undefined : v })
        }
      >
        <SelectTrigger size="sm" className="h-8">
          <SelectValue placeholder="All subjects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All subjects</SelectItem>
          {subjects.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.status ?? "__all__"}
        onValueChange={(v) =>
          onChange({ status: (v === "__all__" ? undefined : v) as DocumentStatus })
        }
      >
        <SelectTrigger size="sm" className="h-8">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All statuses</SelectItem>
          <SelectItem value="uploaded">Uploaded</SelectItem>
          <SelectItem value="processing">Processing</SelectItem>
          <SelectItem value="ready">Ready</SelectItem>
          <SelectItem value="failed">Failed</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
