import { ArrowRightIcon, BookTextIcon, ListChecksIcon, TargetIcon } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FadeIn } from "@/components/landing/fade-in";

const subjects = [
  { name: "C Programming", progress: 82, next: "Pointers practice set" },
  { name: "Engineering Physics", progress: 64, next: "Unit 2 — Electrostatics" },
  {
    name: "Matrices & Calculus",
    progress: 72,
    next: "Eigenvalues Revision",
    highlighted: true,
  },
  { name: "Communication English", progress: 58, next: "Presentation draft" },
];

export function StudentSection() {
  return (
    <section id="students" className="scroll-mt-20 border-y bg-muted/30">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2">
        <FadeIn>
          <div>
            <p className="text-sm font-medium text-primary">For students</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Turn your study material into understanding
            </h2>
            <p className="mt-3 max-w-lg text-muted-foreground">
              Notes become summaries, summaries become quizzes, quizzes become
              confidence. SathuX tracks every subject so revision always
              starts in the right place.
            </p>

            <ul className="mt-6 space-y-3 text-sm">
              {[
                { icon: BookTextIcon, text: "Summaries & exam-style answers from your own notes" },
                { icon: ListChecksIcon, text: "Auto-generated quizzes and flashcards" },
                { icon: TargetIcon, text: "Per-subject progress with a clear next step" },
              ].map((item) => (
                <li key={item.text} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <item.icon className="size-4" />
                  </span>
                  <span className="text-muted-foreground">{item.text}</span>
                </li>
              ))}
            </ul>

            <Button asChild className="group mt-8">
              <Link href="/study">
                Open Study Mode
                <ArrowRightIcon data-icon="inline-end" className="transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </div>
        </FadeIn>

        {/* Subject dashboard preview */}
        <FadeIn delay={0.1}>
          <div className="rounded-2xl border bg-card p-4 shadow-xl shadow-primary/5 sm:p-5">
            <div className="flex items-center justify-between px-1 pb-3">
              <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                Mathematics
              </p>
              <Badge variant="secondary" className="text-[11px]">Week 6</Badge>
            </div>
            <div className="rounded-xl border bg-background p-4">
              <div className="flex items-baseline justify-between">
                <p className="font-medium">Matrices &amp; Calculus</p>
                <p className="text-sm font-semibold text-primary">72%</p>
              </div>
              <Progress value={72} className="mt-3 h-2" aria-label="Course progress 72 percent" />
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <TargetIcon className="size-3.5 text-primary" />
                Next: Eigenvalues Revision
              </div>
            </div>

            <ul className="mt-3 space-y-2">
              {subjects
                .filter((s) => !s.highlighted)
                .map((subject) => (
                  <li
                    key={subject.name}
                    className="flex items-center gap-3 rounded-xl border bg-background p-3"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{subject.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        Next: {subject.next}
                      </span>
                    </span>
                    <span className="w-24 shrink-0">
                      <Progress value={subject.progress} className="h-1.5" aria-label={`${subject.name} progress ${subject.progress} percent`} />
                    </span>
                    <span className="w-9 text-right text-xs font-medium text-muted-foreground">
                      {subject.progress}%
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
