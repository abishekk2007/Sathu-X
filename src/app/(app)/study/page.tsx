import type { Metadata } from "next";

import { StudyDashboard } from "@/components/study/study-dashboard";

export const metadata: Metadata = {
  title: "Study",
};

export default function StudyPage() {
  return <StudyDashboard />;
}
