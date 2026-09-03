import Link from "next/link";
import { Link2Icon } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { SpideyLogo } from "@/components/branding/spidey-logo";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Chat", href: "/chat" },
      { label: "Study Mode", href: "/study" },
      { label: "Documents", href: "/documents" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Student AI", href: "/#students" },
      { label: "Personal Assistant", href: "/#assistant" },
      { label: "GitHub", href: "#" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <SpideyLogo />
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
              Your AI. Your Study Partner. Your Personal Assistant.
            </p>
          </div>
          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <p className="text-sm font-semibold">{column.heading}</p>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <Separator className="my-8" />

        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} SathuX. All rights reserved.
          </p>
          <a
            href="#"
            aria-label="SathuX repository"
            className="flex items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Link2Icon className="size-4" />
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
