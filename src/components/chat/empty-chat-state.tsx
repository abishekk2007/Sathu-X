"use client";

import { motion } from "framer-motion";
import {
  CalendarClockIcon,
  CodeIcon,
  LightbulbIcon,
  NotebookTextIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";

import { SpiderMark } from "@/components/branding/spider-mark";
import { mockSuggestions } from "@/data/mock";

const suggestionIcons: Record<string, typeof LightbulbIcon> = {
  lightbulb: LightbulbIcon,
  calendar: CalendarClockIcon,
  notebook: NotebookTextIcon,
  code: CodeIcon,
  sun: SunIcon,
  sparkles: SparklesIcon,
};

export function EmptyChatState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="relative mb-5"
      >
        <span className="absolute inset-0 -z-10 scale-150 rounded-full bg-primary/15 blur-2xl" />
        <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-600/25">
          <SpiderMark className="size-8" />
        </span>
      </motion.div>

      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        What can I help you with?
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground sm:text-base">
        Ask anything, study smarter, or get things done.
      </p>

      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {mockSuggestions.map((suggestion, i) => {
          const Icon = suggestionIcons[suggestion.icon] ?? SparklesIcon;
          return (
            <motion.button
              key={suggestion.id}
              type="button"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.05 * i, ease: "easeOut" }}
              onClick={() => onPick(suggestion.prompt)}
              className="group flex flex-col gap-2 rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:border-primary/50"
            >
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-medium">{suggestion.title}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
