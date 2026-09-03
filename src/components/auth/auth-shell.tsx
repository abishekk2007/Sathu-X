import Link from "next/link";
import { GraduationCapIcon, BrainIcon, CalendarCheckIcon } from "lucide-react";

import { SpideyLogo } from "@/components/branding/spidey-logo";
import { SpiderMark } from "@/components/branding/spider-mark";

const points = [
  { icon: BrainIcon, text: "An AI that remembers your preferences and subjects" },
  { icon: GraduationCapIcon, text: "Notes, quizzes and exam answers from your own material" },
  { icon: CalendarCheckIcon, text: "Tasks, reminders and a plan for every day" },
];

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <aside
        aria-hidden="true"
        className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 lg:flex"
      >
        <SpiderMark className="absolute -top-16 -right-16 size-72 text-primary/10" />
        <SpiderMark className="absolute bottom-24 -left-20 size-80 text-primary/[0.07]" />
        <div
          aria-hidden="true"
          className="absolute top-1/3 left-1/3 size-96 rounded-full bg-primary/15 blur-[140px]"
        />

        <Link href="/" className="relative">
          <SpideyLogo />
        </Link>

        <div className="relative max-w-md">
          <h2 className="text-3xl leading-snug font-semibold tracking-tight text-balance">
            Your AI. Your Study Partner.{" "}
            <span className="text-gradient">Your Personal Assistant.</span>
          </h2>
          <ul className="mt-8 space-y-4">
            {points.map((point) => (
              <li key={point.text} className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">
                  <point.icon className="size-4.5" />
                </span>
                <span className="text-sm text-muted-foreground">{point.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-muted-foreground/70">
          © {new Date().getFullYear()} SathuX
        </p>
      </aside>

      {/* Form panel */}
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 inline-flex lg:hidden" aria-label="SathuX home">
            <SpideyLogo />
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
