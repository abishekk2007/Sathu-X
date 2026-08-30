"use client";

import { RefreshCwIcon } from "lucide-react";
import { SpiderMark } from "@/components/branding/spider-mark";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <SpiderMark className="size-7" />
      </span>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          An unexpected error occurred. Please try again.
          {error.digest ? (
            <span className="mt-1 block font-mono text-[11px] text-muted-foreground/70">
              Ref: {error.digest}
            </span>
          ) : null}
        </p>
      </div>
      <Button onClick={reset}>
        <RefreshCwIcon data-icon="inline-start" />
        Try again
      </Button>
    </div>
  );
}
