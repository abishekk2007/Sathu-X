import type { Metadata } from "next";

import { TasksBoard } from "@/components/tasks/tasks-board";

export const metadata: Metadata = {
  title: "Tasks",
};

export default function TasksPage() {
  return <TasksBoard />;
}
