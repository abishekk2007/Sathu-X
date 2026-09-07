"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  LayersIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState } from "@/components/shared/error-state";
import { useFlashcards } from "@/hooks/use-flashcards";

/**
 * Real flashcard deck. The visible count and the "Practice deck" action come
 * from the current user's flashcards (RLS-scoped `/api/flashcards`). Empty
 * state lets users add their first card; reviewing marks a card as reviewed
 * today so it leaves the due queue.
 */
export function FlashcardDeck({
  count,
}: {
  count: { total: number; due: number } | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);
  const [adding, setAdding] = React.useState(false);

  const {
    flashcards,
    total,
    loading,
    error,
    reload,
    addFlashcard,
    reviewFlashcard,
    deleteFlashcard,
  } = useFlashcards();

  const card = flashcards[index];
  const cardTotal = flashcards.length > 0 ? flashcards.length : total;

  const goTo = (next: number) => {
    if (cardTotal === 0) return;
    setIndex(((next % cardTotal) + cardTotal) % cardTotal);
    setFlipped(false);
  };

  const handleReview = async () => {
    if (!card) return;
    const ok = await reviewFlashcard(card.id);
    if (!ok) {
      toast.error("Couldn't mark the card as reviewed");
      return;
    }
    setFlipped(false);
    setIndex((current) => (cardTotal > 1 ? (current + 1) % cardTotal : 0));
  };

  const handleDelete = async () => {
    if (!card) return;
    const ok = await deleteFlashcard(card.id);
    if (!ok) {
      toast.error("Couldn't delete the card");
      return;
    }
    setFlipped(false);
  };

  return (
    <>
      <div className="flex h-full flex-col justify-between rounded-2xl border bg-card p-5">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LayersIcon className="size-5" />
        </span>
        <div className="mt-4 flex-1">
          <h3 className="font-semibold">Flashcards</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {count === null
              ? "Loading your flashcards..."
              : count.total === 0
                ? "No flashcards yet — add your first card."
                : `Review ${count.due} card${count.due === 1 ? "" : "s"} to practice.`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-4 self-start"
          onClick={() => setOpen(true)}
        >
          Practice deck
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFlipped(false);
            setIndex(0);
            setAdding(false);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Flashcards</DialogTitle>
            <DialogDescription>
              {cardTotal > 0
                ? `Card ${index + 1} of ${cardTotal} · tap the card to flip`
                : "Your personal flashcard deck"}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-slim py-1">
            {loading && flashcards.length === 0 ? (
              <div className="space-y-2 py-4">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-40 w-full rounded-xl" />
                <Skeleton className="h-4 w-3/5" />
              </div>
            ) : error && flashcards.length === 0 ? (
              <ErrorState
                title="Couldn't load your flashcards."
                description="Check your connection and try again."
                onRetry={() => void reload()}
              />
            ) : cardTotal === 0 ? (
              <div className="py-4 text-center">
                <p className="font-medium">No flashcards yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add a card for a topic you&apos;re studying and it will show up in
                  your daily review queue.
                </p>
              </div>
            ) : card ? (
              <button
                type="button"
                onClick={() => setFlipped((value) => !value)}
                aria-label={flipped ? "Show question" : "Reveal answer"}
                className="flex min-h-40 w-full items-center justify-center rounded-xl border bg-muted/30 p-6 text-center transition-colors hover:bg-muted/50 focus-visible:border-ring"
              >
                {flipped ? (
                  <motion.p
                    key="answer"
                    initial={{ opacity: 0, rotateX: -25 }}
                    animate={{ opacity: 1, rotateX: 0 }}
                    transition={{ duration: 0.25 }}
                    className="max-h-64 overflow-y-auto scrollbar-slim text-sm leading-relaxed text-muted-foreground"
                  >
                    {card.answer}
                  </motion.p>
                ) : (
                  <motion.p
                    key="question"
                    initial={{ opacity: 0, rotateX: 25 }}
                    animate={{ opacity: 1, rotateX: 0 }}
                    transition={{ duration: 0.25 }}
                    className="font-medium"
                  >
                    {card.question}
                  </motion.p>
                )}
              </button>
            ) : null}

            {adding ? (
              <AddCardForm
                onSave={async (input) => {
                  const ok = await addFlashcard(input);
                  if (!ok) {
                    toast.error("Couldn't save the flashcard");
                    return;
                  }
                  toast.success("Flashcard added");
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : null}
          </div>

          <DialogFooter className="mt-4 items-center gap-2 border-t pt-4 sm:justify-between">
            {cardTotal === 0 ? (
              <Button size="sm" onClick={() => setAdding((value) => !value)}>
                <PlusIcon data-icon="inline-start" />
                Add your first card
              </Button>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goTo(index - 1)}
                  >
                    <ChevronLeftIcon data-icon="inline-start" />
                    Prev
                  </Button>
                  {cardTotal <= 12 ? (
                    <div className="flex gap-1" aria-hidden="true">
                      {flashcards.slice(0, cardTotal).map((item, i) => (
                        <span
                          key={item.id}
                          className={`h-1.5 w-5 rounded-full ${i === index ? "bg-primary" : "bg-muted"}`}
                        />
                      ))}
                    </div>
                  ) : null}
                  <Button size="sm" onClick={() => goTo(index + 1)}>
                    Next
                    <ChevronRightIcon data-icon="inline-end" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  {!adding ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAdding(true)}
                      aria-label="Add a flashcard"
                    >
                      <PlusIcon className="size-4" />
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => void handleReview()}
                    disabled={!card}
                  >
                    Mark reviewed
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleDelete()}
                    aria-label="Delete this flashcard"
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddCardForm({
  onSave,
  onCancel,
}: {
  onSave: (input: { question: string; answer: string; subjectId?: string | null }) => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = React.useState("");
  const [answer, setAnswer] = React.useState("");
  const [subjectId, setSubjectId] = React.useState("");
  const [subjects, setSubjects] = React.useState<
    Array<{ id: string; name: string }> | null
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    const response = fetch("/api/subjects?limit=100", {
      headers: { Accept: "application/json" },
    })
      .then((result) =>
        result.ok
          ? (result.json() as Promise<{ subjects?: Array<{ id: string; name: string }> }>)
          : Promise.resolve({})
      )
      .catch(() => null);
    void response.then((data: { subjects?: Array<{ id: string; name: string }> } | null) => {
      if (!cancelled) setSubjects(data?.subjects ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = () => {
    if (!question.trim() || !answer.trim()) {
      toast.error("Fill out both the question and the answer");
      return;
    }
    onSave({
      question: question.trim(),
      answer: answer.trim(),
      subjectId: subjectId || undefined,
    });
    setQuestion("");
    setAnswer("");
    setSubjectId("");
  };

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="fc-question">Question</Label>
        <Textarea
          id="fc-question"
          rows={2}
          placeholder="e.g. What does a pointer store?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fc-answer">Answer</Label>
        <Textarea
          id="fc-answer"
          rows={3}
          placeholder="The concept, explained briefly…"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fc-subject">Subject (optional)</Label>
        <Select value={subjectId} onValueChange={setSubjectId}>
          <SelectTrigger id="fc-subject" className="w-full">
            <SelectValue placeholder="No subject" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">No subject</SelectItem>
            {(subjects ?? []).map((subject) => (
              <SelectItem key={subject.id} value={subject.id}>
                {subject.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit}>
          Save card
        </Button>
      </div>
    </div>
  );
}