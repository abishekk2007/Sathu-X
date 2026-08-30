"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ChevronLeftIcon, ChevronRightIcon, LayersIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mockFlashcards } from "@/data/mock";

export function FlashcardDeck() {
  const [open, setOpen] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const [flipped, setFlipped] = React.useState(false);

  const card = mockFlashcards[index];

  const goTo = (next: number) => {
    setIndex(((next % mockFlashcards.length) + mockFlashcards.length) % mockFlashcards.length);
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
            Review {mockFlashcards.length} cards from your recent topics.
          </p>
        </div>
        <Button variant="outline" size="sm" className="mt-4 self-start" onClick={() => setOpen(true)}>
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
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Flashcards</DialogTitle>
            <DialogDescription>
              Card {index + 1} of {mockFlashcards.length} · tap the card to flip
            </DialogDescription>
          </DialogHeader>

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
                className="text-sm leading-relaxed text-muted-foreground"
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

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" size="sm" onClick={() => goTo(index - 1)}>
              <ChevronLeftIcon data-icon="inline-start" />
              Prev
            </Button>
            <div className="flex gap-1" aria-hidden="true">
              {mockFlashcards.map((item, i) => (
                <span
                  key={item.id}
                  className={`h-1.5 w-5 rounded-full ${i === index ? "bg-primary" : "bg-muted"}`}
                />
              ))}
            </div>
            <Button size="sm" onClick={() => goTo(index + 1)}>
              Next
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
