"use client";

import * as React from "react";
import { BarChart3Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { PageHeader } from "@/components/shared/page-header";
import { ProductivityHistory } from "@/components/productivity/productivity-history";
import { NextActionCard } from "@/components/productivity/next-action-card";
import { ProductivityNotifications } from "@/components/productivity/productivity-notifications";
import { ProductivityScoreCard } from "@/components/productivity/productivity-score-card";
import { ProductivitySummary } from "@/components/productivity/productivity-summary";
import { RecentChatStudy } from "@/components/productivity/recent-chat-study";
import { RoutineSettings } from "@/components/productivity/routine-settings";
import { StreakCard } from "@/components/productivity/streak-card";
import { useProductivity } from "@/hooks/use-productivity";
import { useProfile } from "@/hooks/use-profile";

function buildGreeting(firstName: string | null): string {
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return firstName ? `${timeGreeting}, ${firstName}` : timeGreeting;
}

export function ProductivityDashboard() {
  const {
    dashboard,
    dashboardLoading,
    dashboardError,
    reloadDashboard,
    routine,
    routineLoading,
    updateRoutine,
    refreshAll,
  } = useProductivity();
  const { profile } = useProfile();

  const firstName = profile?.fullName?.split(/\s+/)[0] ?? null;
  const greeting = buildGreeting(firstName);

  const handleRoutineSave = async (patch: {
    preferredSessionMinutes?: number | null;
    preferredBreakMinutes?: number | null;
    preferredStudyTime?: string | null;
    dailyStudyTargetMinutes?: number | null;
  }) => {
    const ok = await updateRoutine(patch);
    if (!ok) {
      toast.error("Could not save preferences. Please try again.");
      return false;
    }
    toast.success("Preferences saved");
    return true;
  };

  const showError = !dashboardLoading && !!dashboardError && !dashboard;
  const showEmpty = !dashboardLoading && !dashboardError && !dashboard;

  return (
    <div className="h-full overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={BarChart3Icon}
          title={greeting}
          description="Your productivity score, streaks and study habits."
          actions={
            <Button size="sm" variant="outline" onClick={refreshAll}>
              Refresh
            </Button>
          }
        />

        {/* ---- Notifications ---- */}
        <ProductivityNotifications
          notifications={dashboard?.notifications ?? []}
          loading={dashboardLoading}
        />

        {showError ? (
          <ErrorState
            title="Couldn't load your productivity data."
            description="Check your connection and try again."
            onRetry={reloadDashboard}
          />
        ) : showEmpty ? (
          <EmptyState
            icon={BarChart3Icon}
            title="No study activity yet."
            description="Complete some study sessions to see your productivity score and streaks."
          />
        ) : dashboard ? (
          <>
            {/* ---- Score + Streak + Next Action ---- */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ProductivityScoreCard score={dashboard.score} loading={false} />
              <StreakCard streak={dashboard.streak} loading={false} />
              <NextActionCard action={dashboard.nextAction} loading={false} />
            </div>

            {/* ---- Summary ---- */}
            <ProductivitySummary
              todayCompletedMinutes={dashboard.today.completedMinutes}
              todayPlannedMinutes={dashboard.today.plannedMinutes}
              weeklyMinutes={dashboard.weeklyStats.totalMinutes}
              weeklyTarget={routine?.dailyStudyTargetMinutes ? routine.dailyStudyTargetMinutes * 7 : null}
              subjectsStudied={dashboard.weeklyStats.subjectsStudied}
              topicsPracticed={dashboard.weeklyStats.topicsPracticed}
              todayPlannerMinutes={dashboard.today.plannerMinutes}
              todayChatMinutes={dashboard.today.chatMinutes}
              weeklyPlannerMinutes={dashboard.weeklyStats.plannerMinutes}
              weeklyChatMinutes={dashboard.weeklyStats.chatMinutes}
              loading={false}
            />

            {/* ---- Recent Chat Study ---- */}
            <RecentChatStudy
              activities={dashboard.recentChatStudy}
              loading={false}
            />

            {/* ---- Recommendation ---- */}
            {dashboard.recommendation ? (
              <div className="rounded-xl bg-primary/5 px-4 py-3 text-sm text-primary ring-1 ring-primary/10">
                {dashboard.recommendation}
              </div>
            ) : null}

            {/* ---- History ---- */}
            <ProductivityHistory history={dashboard.history} loading={false} />

            {/* ---- Routine ---- */}
            <RoutineSettings
              key={`${routine?.preferredSessionMinutes}-${routine?.preferredBreakMinutes}-${routine?.preferredStudyTime}-${routine?.dailyStudyTargetMinutes}`}
              routine={routine}
              loading={routineLoading}
              onSave={handleRoutineSave}
            />
          </>
        ) : (
          /* ---- Loading skeleton ---- */
          <div className="space-y-4" aria-busy="true">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        )}
      </div>
    </div>
  );
}
