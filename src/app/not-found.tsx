import Link from "next/link";
import { ArrowLeftIcon, SearchXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SpiderMark } from "@/components/branding/spider-mark";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4 text-center">
      <span className="relative">
        <span className="absolute inset-0 -z-10 scale-150 rounded-full bg-primary/15 blur-2xl" />
        <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-600/25">
          <SpiderMark className="size-8" />
        </span>
      </span>
      <div className="space-y-2">
        <p className="flex items-center justify-center gap-2 text-sm font-medium tracking-widest text-primary uppercase">
          <SearchXIcon className="size-4" />
          404
        </p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          This page slipped through the web
        </h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or was moved.
        </p>
      </div>
      <Button asChild>
        <Link href="/">
          <ArrowLeftIcon data-icon="inline-start" />
          Back to home
        </Link>
      </Button>
    </div>
  );
}
