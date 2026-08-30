import type { Metadata } from "next";

import { StudentView } from "@/components/student/student-view";

export const metadata: Metadata = {
  title: "Student",
};

export default function StudentPage() {
  return <StudentView />;
}
