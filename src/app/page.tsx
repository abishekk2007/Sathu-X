import { SiteHeader } from "@/components/landing/site-header";
import { Hero } from "@/components/landing/hero";
import { FeatureGrid } from "@/components/landing/feature-grid";
import { StudentSection } from "@/components/landing/student-section";
import { AssistantSection } from "@/components/landing/assistant-section";
import { CapabilitiesStrip } from "@/components/landing/capabilities-strip";
import { CtaSection } from "@/components/landing/cta-section";
import { SiteFooter } from "@/components/landing/site-footer";

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <FeatureGrid />
        <StudentSection />
        <AssistantSection />
        <CapabilitiesStrip />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
