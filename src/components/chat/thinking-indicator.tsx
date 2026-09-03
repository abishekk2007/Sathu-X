"use client";

import { motion } from "framer-motion";

import { SpiderMark } from "@/components/branding/spider-mark";

type ThinkingIndicatorProps = {
  /** Custom loading copy; defaults to "SathuX is thinking". */
  label?: string;
};

export function ThinkingIndicator({ label }: ThinkingIndicatorProps) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-muted-foreground" role="status" aria-live="polite">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <SpiderMark className="size-4" />
      </span>
      <span>{label ?? "SathuX is thinking"}</span>
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-primary"
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </span>
    </div>
  );
}
