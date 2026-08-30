"use client";

import * as React from "react";
import {
  BookOpenIcon,
  BrainIcon,
  BriefcaseIcon,
  CodeIcon,
  GraduationCapIcon,
  HeartIcon,
  MessagesSquareIcon,
  PauseCircleIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  TargetIcon,
  Trash2Icon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { useMemories } from "@/hooks/use-memories";
import type {
  MemoryCategory,
  MemoryRecord,
  MemoryType,
} from "@/types";
import { MEMORY_TYPES } from "@/types";
import { cn } from "@/lib/utils";

const CATEGORY_META: Record<
  MemoryCategory,
  { label: string; icon: typeof BrainIcon }
> = {
  general: { label: "General", icon: SparklesIcon },
  preference: { label: "Preferences", icon: HeartIcon },
  education: { label: "Education", icon: GraduationCapIcon },
  personal: { label: "Personal", icon: UserRoundIcon },
  project: { label: "Projects", icon: CodeIcon },
  academic: { label: "Academic", icon: BookOpenIcon },
  work: { label: "Work", icon: BriefcaseIcon },
  goal: { label: "Goals", icon: TargetIcon },
  communication: { label: "Communication", icon: MessagesSquareIcon },
};

const TYPE_META: Record<MemoryType, { label: string; icon: typeof BrainIcon }> = {
  preference: { label: "Preference", icon: HeartIcon },
  profile: { label: "Profile", icon: UserRoundIcon },
  project: { label: "Project", icon: CodeIcon },
  workflow: { label: "Workflow", icon: SparklesIcon },
  instruction: { label: "Instruction", icon: MessagesSquareIcon },
  fact: { label: "Fact", icon: BrainIcon },
  goal: { label: "Goal", icon: TargetIcon },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_META) as MemoryCategory[];

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Saved ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * Real memory manager backed by /api/memories. Replaces the Phase 2 demo
 * board (mock memories + fake preference toggles).
 */
export function MemoryBoard() {
  const { memories, loading, error, reload, add, update, remove, clearAll, enabled, setEnabled } =
    useMemories();
  const [search, setSearch] = React.useState("");
  const [categoryFilter, setCategoryFilter] =
    React.useState<MemoryCategory | "all">("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MemoryRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<MemoryRecord | null>(null);
  const [clearAllOpen, setClearAllOpen] = React.useState(false);

  const normalizedSearch = search.trim().toLowerCase();
  const visible = memories.filter((memory) => {
    if (categoryFilter !== "all" && memory.category !== categoryFilter) return false;
    if (normalizedSearch && !memory.content.toLowerCase().includes(normalizedSearch))
      return false;
    return true;
  });

  const grouped = ALL_CATEGORIES.map((category) => ({
    category,
    items: visible.filter((memory) => memory.category === category),
  })).filter((group) => group.items.length > 0);

  const handleDialogSubmit = async (
    values: { content: string; category: MemoryCategory; importance: number; type?: MemoryType },
    target: MemoryRecord | null
  ): Promise<boolean> => {
    const result = target
      ? await update(target.id, values)
      : await add(values);
    if (result === "secrets_not_allowed") {
      toast.error("Spidey Bot can't store passwords or secrets.");
      return false;
    }
    if (result) {
      toast.success(target ? "Memory updated" : "Memory saved");
      setDialogOpen(false);
      setEditing(null);
    } else {
      toast.error("Could not save the memory. Please try again.");
    }
    return result === true;
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={BrainIcon}
          title="Spidey Memory"
          description="What Spidey remembers about you."
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={enabled}
                onClick={() => void setEnabled(!enabled)}
              >
                {enabled ? <PauseIcon /> : <PlayIcon />}
                {enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={loading || memories.length === 0 || !enabled}
                onClick={() => setClearAllOpen(true)}
              >
                <Trash2Icon />
                Clear all
              </Button>
              <Button
                size="sm"
                disabled={!enabled}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <PlusIcon />
                Add memory
              </Button>
            </>
          }
        />

        {!enabled && (
          <section
            aria-label="Memory paused"
            className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
          >
            <PauseCircleIcon className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Memory is paused. Spidey Bot won&apos;t recall or save anything
              new until you resume it.
            </span>
          </section>
        )}

        {/* Toolbar: search + category filter */}
        <section aria-label="Filter memories" className="space-y-3">
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search memories…"
              aria-label="Search memories"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={categoryFilter === "all"}
              label={`All · ${memories.length}`}
              onClick={() => setCategoryFilter("all")}
            />
            {ALL_CATEGORIES.map((category) => (
              <FilterChip
                key={category}
                active={categoryFilter === category}
                label={CATEGORY_META[category].label}
                onClick={() => setCategoryFilter(category)}
              />
            ))}
          </div>
        </section>

        {/* Content states */}
        {loading ? (
          <section aria-busy="true" aria-label="Loading memories" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {[0, 1, 2, 3].map((item) => (
              <div key={item} className="h-20 animate-pulse rounded-xl bg-muted/60 ring-1 ring-foreground/5" />
            ))}
            <p className="sr-only">Loading your memories…</p>
          </section>
        ) : error ? (
          <EmptyState
            icon={BrainIcon}
            title="Unable to load memories"
            description="Check your connection and try again."
            action={
              <Button size="sm" variant="outline" onClick={() => void reload()}>
                Retry
              </Button>
            }
          />
        ) : memories.length === 0 ? (
          <EmptyState
            icon={BrainIcon}
            title="Nothing remembered yet"
            description='While chatting, say something like "Remember that I prefer concise explanations" and it will appear here.'
            action={
              <Button size="sm" variant="outline" asChild>
                <Link href="/chat">Start a chat</Link>
              </Button>
            }
          />
        ) : visible.length === 0 ? (
          <p className="rounded-xl border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No memories match your search or filter.
          </p>
        ) : (
          grouped.map(({ category, items }) => {
            const meta = CATEGORY_META[category];
            const Icon = meta.icon;
            return (
              <section key={category} aria-label={`${meta.label} memories`} className="space-y-2.5">
                <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  <Icon className="size-4 text-primary" />
                  {meta.label}
                  <span className="font-normal normal-case">· {items.length}</span>
                </h2>
                <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {items.map((memory) => (
                    <li
                      key={memory.id}
                      className="group flex items-start gap-3 rounded-xl bg-card p-3.5 ring-1 ring-foreground/10 transition-all hover:ring-primary/30"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-relaxed">{memory.content}</span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            {TYPE_META[memory.type].label}
                          </span>
                          <ImportanceDots value={memory.importance} />
                          {formatDate(memory.updatedAt)}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit memory: ${memory.content}`}
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setEditing(memory);
                            setDialogOpen(true);
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete memory: ${memory.content}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(memory)}
                        >
                          <Trash2Icon />
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}

        <p className="rounded-xl border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
          Spidey Bot only uses memories to personalize replies — never to train
          models, and never to store passwords or secrets. Deleting a memory
          removes it permanently.
        </p>
      </div>

      {/* Add / edit */}
      <MemoryDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        initial={editing}
        onSubmit={(values) => handleDialogSubmit(values, editing)}
      />

      {/* Delete one */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete this memory?"
        description={
          deleteTarget
            ? `"${truncate(deleteTarget.content, 80)}" will be permanently removed.`
            : ""
        }
        confirmLabel="Delete memory"
        onConfirm={async () => {
          if (!deleteTarget) return true;
          const ok = await remove(deleteTarget.id);
          if (ok) toast.success("Memory deleted");
          else toast.error("Could not delete the memory. Please try again.");
          setDeleteTarget(null);
          return ok;
        }}
      />

      {/* Clear all */}
      <ConfirmDialog
        open={clearAllOpen}
        onOpenChange={setClearAllOpen}
        title="Clear all memories?"
        description="Are you sure? This will permanently delete all memories. Spidey Bot will no longer know any of these facts."
        confirmLabel="Delete all memories"
        destructive
        onConfirm={async () => {
          const ok = await clearAll();
          if (ok) toast.success("All memories deleted");
          else toast.error("Could not clear memories. Please try again.");
          setClearAllOpen(false);
          return ok;
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ImportanceDots({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((dot) => (
        <span
          key={dot}
          className={cn(
            "size-1.5 rounded-full",
            dot <= value ? "bg-primary" : "bg-muted-foreground/25"
          )}
        />
      ))}
    </span>
  );
}

function FilterChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "text-muted-foreground hover:border-primary/40 hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function MemoryDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: MemoryRecord | null;
  onSubmit: (values: {
    content: string;
    category: MemoryCategory;
    importance: number;
    type?: MemoryType;
  }) => Promise<boolean>;
}) {
  // Radix unmounts dialog content when closed, so each open mounts fresh
  // state seeded from `initial` — no manual re-seeding required.
  const [content, setContent] = React.useState(initial?.content ?? "");
  const [category, setCategory] = React.useState<MemoryCategory>(
    initial?.category ?? "general"
  );
  const [type, setType] = React.useState<MemoryType | "auto">(
    initial?.type ?? "auto"
  );
  const [importance, setImportance] = React.useState(initial?.importance ?? 3);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      setValidationError("Please enter what Spidey should remember.");
      return;
    }
    if (trimmed.length > 500) {
      setValidationError("Memories are limited to 500 characters.");
      return;
    }
    setSubmitting(true);
    const ok = await onSubmit({
      content: trimmed,
      category,
      importance,
      type: type === "auto" ? undefined : type,
    });
    if (!ok) setSubmitting(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!submitting} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit memory" : "Add memory"}</DialogTitle>
          <DialogDescription>
            What should Spidey remember? It will use this in future chats.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="memory-content">Memory</Label>
            <Textarea
              id="memory-content"
              value={content}
              maxLength={500}
              rows={3}
              placeholder="e.g. My favourite programming language is Python"
              onChange={(event) => {
                setContent(event.target.value);
                if (validationError) setValidationError(null);
              }}
              aria-invalid={validationError !== null}
            />
            <div className="flex items-center justify-between text-[11px]">
              {validationError ? (
                <span className="text-destructive">{validationError}</span>
              ) : (
                <span className="text-transparent">.</span>
              )}
              <span className="text-muted-foreground">{content.length}/500</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as MemoryCategory)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_CATEGORIES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {CATEGORY_META[item].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as MemoryType | "auto")}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                {MEMORY_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {TYPE_META[item].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Importance</Label>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Importance">
              {[1, 2, 3, 4, 5].map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={importance === level}
                  onClick={() => setImportance(level)}
                  className={cn(
                    "size-8 rounded-lg border text-xs font-medium transition-colors",
                    importance === level
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:border-primary/40"
                  )}
                >
                  {level}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              5 means core facts about you; 1 is nice to know.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {initial ? "Save changes" : "Save memory"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => setBusy(false));
            }}
          >
            {busy ? "Deleting…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
