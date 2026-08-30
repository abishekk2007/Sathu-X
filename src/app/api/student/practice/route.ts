import { z } from "zod";

import { recordPracticeOutcome } from "@/lib/student-intelligence";
import { getAuthenticatedUser, getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function jsonError(status: number, code: string) {
  return Response.json({ error: code }, { status });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const practiceSchema = z.object({
  topicId: z.string().uuid(),
  correct: z.boolean(),
});

/**
 * Lightweight practice-outcome recording (Step 12): one correct/incorrect
 * result against a topic the user owns. The deterministic engine updates the
 * knowledge row and mirrors mastery/status onto the topic.
 */
export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return jsonError(401, "unauthorized");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_request");
  }

  const parsed = practiceSchema.safeParse(body);
  if (!parsed.success) return jsonError(400, "invalid_request");

  const { topicId, correct } = parsed.data;
  if (!UUID_PATTERN.test(topicId)) return jsonError(404, "not_found");

  try {
    const supabase = await getSupabaseServerClient();
    const result = await recordPracticeOutcome(supabase, topicId, correct);

    // Foreign/unknown topic → indistinguishable from missing → 404.
    if (!result) {
      console.error("[api/student/practice] No owned topic matched");
      return jsonError(404, "not_found");
    }

    return Response.json({
      knowledge: {
        id: result.knowledge.id,
        topicId: result.knowledge.topicId,
        strengthScore: result.knowledge.strengthScore,
        confidenceScore: result.knowledge.confidenceScore,
        attemptCount: result.knowledge.attemptCount,
        correctCount: result.knowledge.correctCount,
        lastReviewedAt: result.knowledge.lastReviewedAt,
        updatedAt: result.knowledge.lastReviewedAt,
      },
      topicMastery: result.topicMastery,
      topicStatus: result.topicStatus,
    });
  } catch {
    console.error("[api/student/practice] crashed");
    return jsonError(500, "server_error");
  }
}
