import { ArrowRightIcon, BellRingIcon, CalendarClockIcon, ListTodoIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { PriorityDot } from "@/components/shared/priority-dot";
import { FadeIn } from "@/components/landing/fade-in";

const planItems = [
  { time: "7:00 PM", label: "Physics — Unit 2 revision", icon: CalendarClockIcon },
  { time: "8:30 PM", label: "C assignment (30 min focus)", icon: ListTodoIcon },
  { time: "9:15 PM", label: "Flashcards wind-down", icon: BellRingIcon },
];

const tasks = [
  { title: "Revise Physics Unit 2", due: "Today", priority: "high" as const },
  { title: "Complete C assignment", due: "Tomorrow", priority: "medium" as const },
];

export function AssistantSection() {
  return (
    <section id="assistant" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        {/* Day plan preview */}
        <FadeIn className="order-2 lg:order-1">
          <div className="rounded-2xl border bg-card p-4 shadow-xl shadow-primary/5 sm:p-5">
            <div className="flex items-center justify-between px-1 pb-3">
              <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                Today&apos;s plan
              </p>
              <span className="text-[11px] text-muted-foreground">Evening · 3 blocks</span>
            </div>
            <ol className="relative space-y-2 pl-4 before:absolute before:inset-y-2 before:left-[7px] before:w-px before:bg-border">
              {planItems.map((item) => (
                <li key={item.time} className="relative rounded-xl border bg-background p-3">
                  <span
                    aria-hidden="true"
                    className="absolute top-1/2 -left-4 size-[9px] -translate-y-1/2 rounded-full border-2 border-primary bg-background"
                  />
                  <div className="flex items-center gap-3">
                    <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <item.icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{item.time}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ol>

            <ul className="mt-3 space-y-1.5 px-1">
              {tasks.map((task) => (
                <li key={task.title} className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2">
                  <span className="truncate text-sm">{task.title}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                    {task.due}
                    <PriorityDot priority={task.priority} showLabel={false} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </FadeIn>

        <FadeIn delay={0.08} className="order-1 lg:order-2">
          <div>
            <p className="text-sm font-medium text-primary">Personal assistant</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              Plan your day with AI
            </h2>
            <p className="mt-3 max-w-lg text-muted-foreground">
              Tasks, reminders and a realistic daily plan — built around your
              classes, your energy, and what actually needs to get done.
            </p>
            <Button variant="outline" asChild className="group mt-8">
              <Link href="/tasks">
                See tasks &amp; reminders
                <ArrowRightIcon data-icon="inline-end" className="transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
