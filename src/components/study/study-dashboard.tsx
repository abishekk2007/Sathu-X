"use client";

import * as React from "react";
import {
  ArrowRightIcon,
  ClockIcon,
  FlameIcon,
  TargetIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PageHeader } from "@/components/shared/page-header";
import { mockStudyActivities, mockStudySubjects, mockStudyTools } from "@/data/mock";
import { FlashcardDeck } from "@/components/study/flashcard-deck";
import { ToolDialog, toolIcons } from "@/components/study/tool-dialog";
import type { StudyTool } from "@/data/mock";

export function StudyDashboard() {
  const [activeTool, setActiveTool] = React.useState<StudyTool | null>(null);

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          title="Study with Spidey"
          description="Turn your study material into understanding."
        />

        {/* Today's stats + tools */}
        <section
          aria-label="Study tools"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Card className="bg-gradient-to-br from-primary/12 to-indigo-500/10 ring-primary/25">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
                <FlameIcon className="size-4 text-primary" />
                Today&apos;s study
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tracking-tight">2h 15m</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Goal · 3h</p>
              <Progress value={75} className="mt-3 h-1.5" aria-label="Daily goal 75 percent complete" />
            </CardContent>
          </Card>

          {mockStudyTools.slice(0, 3).map((tool) => (
            <ToolCard key={tool.id} tool={tool} onOpen={() => setActiveTool(tool)} />
          ))}
        </section>

        <section
          aria-label="More study tools"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          {mockStudyTools.slice(3).map((tool) => (
            <ToolCard key={tool.id} tool={tool} onOpen={() => setActiveTool(tool)} />
          ))}
          <FlashcardDeck />
        </section>

        {/* Subjects */}
        <section aria-label="Subjects" className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Your subjects
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {mockStudySubjects.map((subject) => (
              <Card key={subject.id} size="sm">
                <CardHeader>
                  <CardTitle>{subject.name}</CardTitle>
                  <p className="text-xs font-semibold text-primary">{subject.progress}%</p>
                </CardHeader>
                <CardContent>
                  <Progress
                    value={subject.progress}
                    className="h-1.5"
                    aria-label={`${subject.name} progress ${subject.progress} percent`}
                  />
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">
                      Next: {subject.nextTopic}
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => toast.success(`Resuming ${subject.name} — demo only.`)}
                        >
                          Continue
                          <ArrowRightIcon data-icon="inline-end" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Jump back in</TooltipContent>
                    </Tooltip>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Recent activity */}
        <section aria-label="Recent activity" className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Recent activity
          </h2>
          <ul className="divide-y rounded-2xl border bg-card">
            {mockStudyActivities.map((activity) => (
              <li key={activity.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <TargetIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {activity.action} · <span className="font-medium">{activity.subject}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <ClockIcon className="size-3.5" />
                  {activity.timeLabel}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <ToolDialog tool={activeTool} open={activeTool !== null} onOpenChange={(open) => !open && setActiveTool(null)} />
    </div>
  );
}

function ToolCard({ tool, onOpen }: { tool: StudyTool; onOpen: () => void }) {
  const Icon = toolIcons[tool.icon];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full flex-col justify-between rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-all hover:-translate-y-0.5 hover:ring-primary/40"
    >
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="size-4.5" />
      </span>
      <span className="mt-3 block font-medium">{tool.title}</span>
      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
        {tool.description}
      </span>
    </button>
  );
}
