import type { Metadata } from "next";

import { RemindersBoard } from "@/components/reminders/reminders-board";

export const metadata: Metadata = {
  title: "Reminders",
};

export default function RemindersPage() {
  return <RemindersBoard />;
}
