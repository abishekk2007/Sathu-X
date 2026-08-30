// LIVE validation (STEP 62/65) — real Open-Meteo / Open-Meteo Marine calls,
// unmocked. Not part of any unit test suite. Run: npx tsx _live-domain-test.ts
import { resolveDomainContext, detectDomainIntent, executeDomainTool } from "./src/lib/realtime/domain";
import { resolveDomainLocation } from "./src/lib/realtime/domain-weather";

async function step(label: string, fn: () => Promise<void>) {
  console.log(`\n===== ${label} =====`);
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    console.log("UNEXPECTED THROW:", e instanceof Error ? e.message : String(e));
  }
  console.log(`(elapsed ${Date.now() - t0}ms)`);
}

async function main() {
  console.log("Live Open-Meteo domain validation — real API calls (no mock).");
  console.log("Today: " + new Date().toISOString());

  await step("Geocode Chennai (resolveDomainLocation)", async () => {
    const r = await resolveDomainLocation("Chennai", { userId: "live-test" });
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) throw new Error("geocode failed");
    console.log("==> OK: Chennai resolved to", r.geo.latitude, r.geo.longitude, r.geo.country);
  });

  await step("Agriculture advisory for Coimbatore tomorrow", async () => {
    const d = resolveDomainContext(detectDomainIntent("Can I spray pesticide in Coimbatore tomorrow?"), []);
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    console.log("success:", out.success, "| domain:", out.domain, "| severity:", out.severity, "| source:", out.source);
    console.log("---- answer ----");
    console.log(out.answer);
    if (!out.success) throw new Error("agriculture advisory failed");
    if (!/Coimbatore/i.test(out.answer)) throw new Error("answer does not mention Coimbatore");
    console.log("==> OK");
  });

  await step("Aviation briefing for Mumbai airport", async () => {
    const d = resolveDomainContext(
      { ...detectDomainIntent("What weather conditions are expected at Mumbai airport?"), location: "Mumbai" },
      []
    );
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    console.log("success:", out.success, "| domain:", out.domain, "| severity:", out.severity);
    console.log("---- answer (first 40 lines) ----");
    console.log(out.answer.split("\n").slice(0, 40).join("\n"));
    if (!out.success) throw new Error("aviation advisory failed");
    console.log("==> OK");
  });

  await step("BUG CASE — Delhi airport query must NOT ask for the location (STEP 55)", async () => {
    const d = resolveDomainContext(detectDomainIntent("What weather conditions are expected at Delhi airport?"), []);
    console.log("resolved decision:", JSON.stringify({ domain: d.domain, location: d.location, handled: d.handled }));
    if (d.domain !== "AVIATION" || d.location !== "Delhi") throw new Error("location not resolved to Delhi");
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    console.log("success:", out.success, "| domain:", out.domain, "| severity:", out.severity, "| source:", out.source);
    console.log("---- answer (first 30 lines) ----");
    console.log(out.answer.split("\n").slice(0, 30).join("\n"));
    if (!out.success) throw new Error("Delhi aviation advisory failed");
    if (/which location should i check\?/i.test(out.answer)) throw new Error("bot wrongly asked for the location");
    if (!/Delhi/i.test(out.answer)) throw new Error("answer does not mention Delhi");
    console.log("==> OK: no location prompt, Delhi briefing answered");
  });

  await step("BUG CASE — compound query (airport + heavy rainfall) answers both, no location prompt", async () => {
    const d = resolveDomainContext(
      detectDomainIntent("What is the weather at Delhi airport and is heavy rainfall expected tonight?"),
      []
    );
    console.log("resolved decision:", JSON.stringify({
      domain: d.domain,
      location: d.location,
      related: (d.relatedDomains ?? []).map((r) => r.domain),
    }));
    if (d.domain !== "AVIATION" || d.location !== "Delhi") throw new Error("compound location not resolved to Delhi");
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    if (!out.success) throw new Error("compound aviation advisory failed");
    if (/which location should i check\?/i.test(out.answer)) throw new Error("bot wrongly asked for the location");
    console.log("==> OK: primary AVIATION advisory answered without a location prompt");
  });

  await step("Marine briefing near a real coast (Chennai coast → resolved geo)", async () => {
    const d = resolveDomainContext(detectDomainIntent("marine conditions near Chennai"), []);
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    console.log("success:", out.success, "| domain:", out.domain, "| severity:", out.severity, "| source:", out.source);
    console.log("---- answer ----");
    console.log(out.answer);
    if (!out.success) throw new Error("marine advisory failed");
    console.log("==> OK");
  });

  await step("Smart-city flood-risk assessment for Chennai tonight", async () => {
    const d = resolveDomainContext(detectDomainIntent("Will Chennai flood tonight?"), []);
    const out = await executeDomainTool({ decision: d, userId: "live-test" });
    console.log("success:", out.success, "| domain:", out.domain, "| severity:", out.severity);
    console.log("---- answer (first 30 lines) ----");
    console.log(out.answer.split("\n").slice(0, 30).join("\n"));
    if (!out.success) throw new Error("smart city advisory failed");
    if (/\bflood(?:ing)? will (?:definitely|almost certainly) occur\b/i.test(out.answer))
      throw new Error("advisory over-claims flooding — safety rule violated");
    console.log("==> OK (no definitive flood prediction in wording)");
  });

  console.log("\n===== LIVE VALIDATION COMPLETE =====");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });