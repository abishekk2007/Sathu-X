import type { Metadata } from "next";

import { ProductivityDashboard } from "@/components/productivity/productivity-dashboard";

export const metadata: Metadata = {
  title: "Productivity",
};

export default function ProductivityPage() {
  return <ProductivityDashboard />;
}
