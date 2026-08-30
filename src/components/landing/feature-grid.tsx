import {
  BrainIcon,
  CalendarCheckIcon,
  FileSearchIcon,
  GraduationCapIcon,
  MessageSquareIcon,
  MicIcon,
} from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";

const features = [
  {
    icon: MessageSquareIcon,
    title: "General AI",
    description: "Ask anything. Get clear answers.",
  },
  {
    icon: GraduationCapIcon,
    title: "Student AI",
    description: "Turn notes into understanding.",
  },
  {
    icon: CalendarCheckIcon,
    title: "Personal Assistant",
    description: "Plan your day with AI.",
  },
  {
    icon: FileSearchIcon,
    title: "Document Intelligence",
    description: "Upload. Ask. Understand.",
  },
  {
    icon: BrainIcon,
    title: "Memory",
    description: "Spidey Bot remembers what matters.",
  },
  {
    icon: MicIcon,
    title: "Voice",
    description: "Talk naturally with your AI.",
  },
];

export function FeatureGrid() {
  return (
    <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6 sm:py-24">
      <FadeIn>
        <div className="max-w-2xl">
          <p className="text-sm font-medium text-primary">Features</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            One assistant for every part of your day
          </h2>
          <p className="mt-3 text-muted-foreground">
            From late-night study sessions to keeping life admin on track —
            Spidey Bot switches roles so you don&apos;t have to switch apps.
          </p>
        </div>
      </FadeIn>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature, i) => (
          <FadeIn key={feature.title} delay={0.05 * i}>
            <div className="group h-full rounded-2xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
              <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <feature.icon className="size-5" />
              </span>
              <h3 className="mt-4 font-semibold">{feature.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </div>
          </FadeIn>
        ))}
      </div>
    </section>
  );
}
