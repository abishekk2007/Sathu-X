import type { Metadata } from "next";

import { PlannerView } from "@/components/planner/planner-view";

export const metadata: Metadata = {
  title: "Study Planner",
  description: "Exams, study plans, sessions and goals.",
};

export default function PlannerPage() {
  return <PlannerView />;
}
