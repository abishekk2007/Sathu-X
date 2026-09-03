import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SpiderMark } from "@/components/branding/spider-mark";
import { FadeIn } from "@/components/landing/fade-in";

export function CtaSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
      <FadeIn>
        <div className="relative overflow-hidden rounded-3xl border bg-card px-6 py-16 text-center shadow-xl shadow-primary/5 sm:px-12">
          <div
            aria-hidden="true"
            className="absolute top-[-160px] left-1/2 size-[420px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]"
          />
          <span className="relative mx-auto flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-600/25">
            <SpiderMark className="size-7" />
          </span>
          <h2 className="relative mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Your AI. Your way.
          </h2>
          <p className="relative mx-auto mt-3 max-w-md text-muted-foreground">
            Start a conversation, upload your notes, or plan tomorrow — SathuX
            keeps up with however you work.
          </p>
          <Button size="lg" asChild className="group relative mt-8 h-11 px-7">
            <Link href="/signup">
              Start with SathuX
              <ArrowRightIcon data-icon="inline-end" className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </div>
      </FadeIn>
    </section>
  );
}
