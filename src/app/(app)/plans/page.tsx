import type { Metadata } from "next";

import { PlansBoard } from "@/components/tasks/plans-board";

export const metadata: Metadata = {
  title: "Plans",
  description: "Multi-step plans for exams, assignments and goals.",
};

export default function PlansPage() {
  return <PlansBoard />;
}