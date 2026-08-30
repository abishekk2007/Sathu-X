import type { Metadata } from "next";

import { MemoryBoard } from "@/components/memory/memory-board";

export const metadata: Metadata = {
  title: "Memory",
};

export default function MemoryPage() {
  return <MemoryBoard />;
}
