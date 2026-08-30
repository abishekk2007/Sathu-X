"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRightIcon,
  BookOpenCheckIcon,
  CircleCheckIcon,
  SparklesIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SpiderMark } from "@/components/branding/spider-mark";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Backdrop: faint grid + violet glow */}
      <div aria-hidden="true" className="bg-grid absolute inset-0 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_35%,black,transparent)]" />
      <div
        aria-hidden="true"
        className="absolute top-[-220px] left-1/2 -z-10 size-[560px] -translate-x-1/2 rounded-full bg-primary/20 blur-[140px]"
      />

      <div className="mx-auto max-w-6xl px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <span className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <SparklesIcon className="size-3.5 text-primary" />
            Your AI. Your Study Partner. Your Personal Assistant.
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08, ease: "easeOut" }}
          className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-6xl"
        >
          Meet <span className="text-gradient">Spidey&nbsp;Bot.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.16, ease: "easeOut" }}
          className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground text-balance sm:text-lg"
        >
          One AI for conversations, studying, productivity, and everything in
          between — built to remember what matters to you.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.24, ease: "easeOut" }}
          className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <Button size="lg" asChild className="group h-11 w-full px-6 sm:w-auto">
            <Link href="/chat">
              Start Chatting
              <ArrowRightIcon data-icon="inline-end" className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" asChild className="h-11 w-full px-6 sm:w-auto">
            <a href="#features">Explore Features</a>
          </Button>
        </motion.div>

        {/* Product preview */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.32, ease: "easeOut" }}
          className="relative mx-auto mt-14 max-w-4xl sm:mt-16"
        >
          {/* Floating student card */}
          <div className="absolute -top-8 -left-2 z-10 hidden w-52 rotate-[-3deg] rounded-xl border bg-card p-3 shadow-lg md:block lg:-left-16">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
                <BookOpenCheckIcon className="size-4" />
              </span>
              <p className="text-xs font-medium">Quiz generated</p>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              Physics Unit 2 · 10 questions · ready to practice
            </p>
          </div>

          {/* Floating task card */}
          <div className="absolute -right-2 -bottom-6 z-10 hidden w-56 rotate-[2deg] rounded-xl border bg-card p-3 shadow-lg md:block lg:-right-14">
            <div className="flex items-center gap-2">
              <CircleCheckIcon className="size-4 text-primary" />
              <p className="text-xs font-medium">Revise eigenvalues</p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Today · Mathematics · done at 6:40 PM
            </p>
          </div>

          {/* Chat window mock */}
          <div className="overflow-hidden rounded-2xl border bg-card text-left shadow-2xl shadow-primary/10 ring-1 ring-foreground/5">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
                <SpiderMark className="size-4" />
              </span>
              <p className="text-xs font-medium">Spidey Bot</p>
              <span className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                Student mode
              </span>
            </div>
            <div className="space-y-4 p-4 sm:p-6">
              <div className="flex justify-end">
                <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[13px] leading-relaxed text-primary-foreground">
                  Turn my physics notes into a quiz before Friday&apos;s test.
                </p>
              </div>
              <div className="flex gap-2.5">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <SpiderMark className="size-3.5" />
                </span>
                <div className="space-y-2 text-[13px] leading-relaxed">
                  <p>
                    Done! I pulled <strong>12 key concepts</strong> from your Unit
                    2 notes and built two quizzes:
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-muted-foreground marker:text-primary">
                    <li>Quick recall · 10 questions, ~5 minutes</li>
                    <li>Exam drill · 6 structured answers with marks</li>
                  </ul>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {["Start quick recall", "Exam drill", "Save flashcards"].map(
                      (chip) => (
                        <span
                          key={chip}
                          className="rounded-lg border bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
                        >
                          {chip}
                        </span>
                      )
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
