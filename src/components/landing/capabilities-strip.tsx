import {
  BrainIcon,
  FileSearchIcon,
  GraduationCapIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MicIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";

const capabilities = [
  { label: "Chat", icon: MessageSquareIcon },
  { label: "Study", icon: GraduationCapIcon },
  { label: "Documents", icon: FileSearchIcon },
  { label: "Memory", icon: BrainIcon },
  { label: "Voice", icon: MicIcon },
  { label: "Search", icon: SearchIcon },
  { label: "Tasks", icon: ListTodoIcon },
  { label: "Tools", icon: WrenchIcon },
];

export function CapabilitiesStrip() {
  return (
    <section className="border-y bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <FadeIn>
          <h2 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
            Everything SathuX can do
          </h2>
        </FadeIn>
        <FadeIn delay={0.08}>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
            {capabilities.map((capability) => (
              <li
                key={capability.label}
                className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <capability.icon className="size-4 text-primary" />
                {capability.label}
              </li>
            ))}
          </ul>
        </FadeIn>
      </div>
    </section>
  );
}
