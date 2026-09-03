"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  AlarmClockIcon,
  BarChart3Icon,
  BookOpenIcon,
  BrainIcon,
  CalendarDaysIcon,
  FileTextIcon,
  GraduationCapIcon,
  ListChecksIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MoonIcon,
  SunIcon,
  TargetIcon,
  UserIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { primaryNav, settingsNav } from "@/components/layout/nav-config";
import {
  EMPTY_CONVERSATIONS,
  getPublishedConversations,
  subscribeToConversations,
} from "@/lib/conversation-store";
import { mockTasks } from "@/data/mock";
import type { DocumentRecord, MemoryRecord } from "@/types";

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandPaletteContext = React.createContext<CommandPaletteContextValue | null>(
  null
);

export function useCommandPalette() {
  const context = React.useContext(CommandPaletteContext);
  if (!context) {
    throw new Error("useCommandPalette must be used within AppShell");
  }
  return context;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();

  // Real chats published by ChatWorkspace (empty until the sidebar loads).
  // The server snapshot is the module-level cached empty array — a fresh []
  // per call would trip React's getServerSnapshot caching warning.
  const conversations = React.useSyncExternalStore(
    subscribeToConversations,
    getPublishedConversations,
    () => EMPTY_CONVERSATIONS
  );

  // Real memories, fetched lazily the first time the palette opens so no
  // request fires on landing/auth pages. Failures (e.g. logged out) simply
  // leave the section empty.
  const [memories, setMemories] = React.useState<MemoryRecord[]>([]);
  const [paletteDocs, setPaletteDocs] = React.useState<DocumentRecord[]>([]);
  React.useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      void (async () => {
        try {
          const [memRes, docRes] = await Promise.all([
            fetch("/api/memories?limit=8", {
              headers: { Accept: "application/json" },
            }),
            fetch("/api/documents?limit=8", {
              headers: { Accept: "application/json" },
            }),
          ]);
          if (memRes.ok) {
            const data = (await memRes.json()) as { memories?: MemoryRecord[] };
            setMemories(Array.isArray(data.memories) ? data.memories.slice(0, 8) : []);
          }
          if (docRes.ok) {
            const data = (await docRes.json()) as { documents?: DocumentRecord[] };
            setPaletteDocs(Array.isArray(data.documents) ? data.documents.slice(0, 8) : []);
          }
        } catch {
          /* palette simply shows no results */
        }
      })();
    });
  }, [open]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = React.useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  return (
    <CommandPaletteContext.Provider value={{ open, setOpen }}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Search SathuX"
        description="Search chats, documents, tasks and memories, or jump to a page."
      >
        <CommandInput placeholder="Search or jump to..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => go("/chat")}>
              <MessageSquarePlusIcon />
              New Chat
            </CommandItem>
            <CommandItem onSelect={() => go("/tasks")}>
              <ListChecksIcon />
              Create Task
            </CommandItem>
            <CommandItem onSelect={() => go("/reminders")}>
              <AlarmClockIcon />
              Create Reminder
            </CommandItem>
            <CommandItem
              onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              <SunIcon className="dark:hidden" />
              <MoonIcon className="hidden dark:block" />
              Toggle Theme
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Navigate">
            <CommandItem onSelect={() => go("/settings")} value="profile">
              <UserIcon />
              Profile
              <span className="ml-auto text-xs text-muted-foreground">
                Your name, college and preferences
              </span>
            </CommandItem>
            {[...primaryNav, settingsNav].map((item) => (
              <CommandItem key={item.href} onSelect={() => go(item.href)}>
                <item.icon />
                {item.title}
                <span className="ml-auto text-xs text-muted-foreground">
                  {item.description}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Study">
            <CommandItem onSelect={() => go("/student")}>
              <BookOpenIcon />
              Student Dashboard
              <span className="ml-auto text-xs text-muted-foreground">
                Mastery, weak topics and practice
              </span>
            </CommandItem>
            <CommandItem onSelect={() => go("/productivity")}>
              <BarChart3Icon />
              Productivity
              <span className="ml-auto text-xs text-muted-foreground">
                Score, streaks and study habits
              </span>
            </CommandItem>
            <CommandItem onSelect={() => go("/planner")}>
              <CalendarDaysIcon />
              Study Planner
              <span className="ml-auto text-xs text-muted-foreground">
                Plans, sessions and progress
              </span>
            </CommandItem>
            <CommandItem value="today plan" onSelect={() => go("/planner?tab=today")}>
              <ListTodoIcon />
              Today&apos;s Plan
            </CommandItem>
            <CommandItem onSelect={() => go("/planner?tab=exams")}>
              <GraduationCapIcon />
              Exams
            </CommandItem>
            <CommandItem value="study goals" onSelect={() => go("/planner?tab=goals")}>
              <TargetIcon />
              Goals
            </CommandItem>
            <CommandItem value="subjects" onSelect={() => go("/student")}>
              <BookOpenIcon />
              Subjects
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          {conversations.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="Conversations">
                {conversations.map((conversation) => (
                  <CommandItem
                    key={conversation.id}
                    value={`chat ${conversation.title}`}
                    onSelect={() => go(`/chat?c=${conversation.id}`)}
                  >
                    <MessageSquareIcon />
                    <span className="truncate">
                      {conversation.title?.trim() || "New conversation"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
          <CommandGroup heading="Documents">
            {paletteDocs.map((document) => (
              <CommandItem
                key={document.id}
                value={`document ${document.name}`}
                onSelect={() => go("/documents")}
              >
                <FileTextIcon />
                {document.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Tasks">
            {mockTasks.slice(0, 5).map((task) => (
              <CommandItem
                key={task.id}
                value={`task ${task.title}`}
                onSelect={() => go("/tasks")}
              >
                <ListChecksIcon />
                {task.title}
              </CommandItem>
            ))}
          </CommandGroup>
          {memories.length > 0 ? (
            <CommandGroup heading="Memories">
              {memories.map((memory) => (
                <CommandItem
                  key={memory.id}
                  value={`memory ${memory.content}`}
                  onSelect={() => go("/memory")}
                >
                  <BrainIcon />
                  <span className="truncate">{memory.content}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </CommandDialog>
    </CommandPaletteContext.Provider>
  );
}
