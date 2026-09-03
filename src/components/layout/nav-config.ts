import {
  BarChart3Icon,
  BellRingIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarDaysIcon,
  FileTextIcon,
  FolderKanbanIcon,
  GraduationCapIcon,
  ListChecksIcon,
  MessageSquareIcon,
  SettingsIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: typeof MessageSquareIcon;
  description: string;
}

export const primaryNav: NavItem[] = [
  {
    title: "Chat",
    href: "/chat",
    icon: MessageSquareIcon,
    description: "Talk to SathuX",
  },
  {
    title: "Student",
    href: "/student",
    icon: BookOpenIcon,
    description: "Subjects, topics and progress",
  },
  {
    title: "Planner",
    href: "/planner",
    icon: CalendarDaysIcon,
    description: "Exams, study plans and goals",
  },
  {
    title: "Study",
    href: "/study",
    icon: GraduationCapIcon,
    description: "Learn smarter with AI tools",
  },
  {
    title: "Documents",
    href: "/documents",
    icon: FileTextIcon,
    description: "Ask questions across your files",
  },
  {
    title: "Tasks",
    href: "/tasks",
    icon: ListChecksIcon,
    description: "Track what needs doing",
  },
  {
    title: "Plans",
    href: "/plans",
    icon: FolderKanbanIcon,
    description: "Multi-step plans and goals",
  },
  {
    title: "Productivity",
    href: "/productivity",
    icon: BarChart3Icon,
    description: "Score, streaks and study habits",
  },
  {
    title: "Reminders",
    href: "/reminders",
    icon: BellRingIcon,
    description: "Never miss a study block",
  },
  {
    title: "Memory",
    href: "/memory",
    icon: BrainIcon,
    description: "What SathuX remembers",
  },
];

export const settingsNav: NavItem = {
  title: "Settings",
  href: "/settings",
  icon: SettingsIcon,
  description: "Preferences and privacy",
};
