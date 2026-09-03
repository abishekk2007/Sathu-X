// ---------------------------------------------------------------------------
// Automated tests for Phase 7F — Advanced Multimodal (pure, deterministic).
// Run with: npx tsx test-phase7f.ts
//
// 7F builds ON the existing camera/clipboard → `uploadedImage` → Gemini
// pipeline (7E) — it adds NO second multimodal pipeline. This suite locks down
// the Phase 7F primitives:
//
//   A. Image + web intent          — image-intent.ts (pure detectors)
//   B. Web image results           — detect.ts detectWebImageRequest
//   C. Location sanitize/links     — location.ts (never raw coords leak)
//   D. Tavily images               — tavily.ts include_images normalization
//   E. Control frames carry images — evidence.ts (web + hybrid round-trip)
//   F. researchWeb force/includeImages — index.ts (intent-driven runs)
//   G. Router: image+web & web-image turns — query-router.ts branch 7C+
//   H. Precedence preserved        — generation/doc never hijacked by web
//
// No live network / Supabase / Gemini calls.
// ---------------------------------------------------------------------------

import {
  detectWebImageRequest,
  hasFreshnessSignal,
} from "./src/lib/web-research/detect";
import { detectImageWebSearchIntent } from "./src/lib/web-research/image-intent";
import {
  buildGoogleMapsSearchLink,
  nearMePhrase,
  sanitizeUserLocation,
} from "./src/lib/location";
import { searchTavilyWithImages } from "./src/lib/web-research/tavily";
import {
  buildSourcesControlFrame,
  parseSourcesControlFrame,
  buildHybridControlFrame,
  parseHybridControlFrame,
} from "./src/lib/web-research/evidence";
import { researchWeb } from "./src/lib/web-research";
import { routeQuery } from "./src/lib/agent";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ===========================================================================
// A. Image + web intent (explicit commerce/web phrasing beside a photo)
// ===========================================================================
// 7F.4 / 7F.5 / 7F.1 — the pure detector that the router gates on the fresh
// "upload" image key. Must be conservative: ordinary vision NEVER triggers it.
assert(detectImageWebSearchIntent("Where can I buy this product online?") === true, "IMG_WEB_BUY_PRODUCT");
assert(detectImageWebSearchIntent("how much does this cost") === true, "IMG_WEB_COST");
assert(detectImageWebSearchIntent("What is the latest version of this device?") === true, "IMG_WEB_VERSION");
assert(detectImageWebSearchIntent("What model is this phone?") === true, "IMG_WEB_MODEL");
assert(detectImageWebSearchIntent("Find information about this object.") === true, "IMG_WEB_FIND_INFO");
assert(detectImageWebSearchIntent("Look up reviews of this gadget online") === true, "IMG_WEB_REVIEWS");
assert(detectImageWebSearchIntent("where can I order this") === true, "IMG_WEB_ORDER");

// Negatives — vision-only, generation, or unrelated asks NEVER fire.
assert(detectImageWebSearchIntent("Describe this image") === false, "IMG_WEB_NEG_DESCRIBE");
assert(detectImageWebSearchIntent("What is this?") === false, "IMG_WEB_NEG_WHAT");
assert(detectImageWebSearchIntent("What does this photo show?") === false, "IMG_WEB_NEG_WHAT_SHOW");
assert(detectImageWebSearchIntent("Generate an image of a dragon") === false, "IMG_WEB_NEG_GENERATE");
assert(detectImageWebSearchIntent("rename this file") === false, "IMG_WEB_NEG_RENAME");
assert(detectImageWebSearchIntent("is this a cat") === false, "IMG_WEB_NEG_CAT");
assert(detectImageWebSearchIntent("this is great") === false, "IMG_WEB_NEG_GREAT");

// ===========================================================================
// B. Web image RESULT requests ("show me images of…")
// ===========================================================================
assert(detectWebImageRequest("Show me images of the Eiffel Tower") === true, "WEBIMG_SHOW_IMAGES");
assert(detectWebImageRequest("show me pictures of cats") === true, "WEBIMG_SHOW_PICTURES");
assert(detectWebImageRequest("Find photos of vintage cars") === true, "WEBIMG_FIND_PHOTOS");
assert(detectWebImageRequest("Give me images for a study summary") === true, "WEBIMG_GIVE");
assert(detectWebImageRequest("images of mars rovers") === true, "WEBIMG_NOUN_FIRST");
assert(detectWebImageRequest("What does a carpi look like?") === true, "WEBIMG_LOOKS_LIKE");

// Negatives — never a vision/generation/text-research collision.
assert(detectWebImageRequest("Describe this image") === false, "WEBIMG_NEG_DESCRIBE");
assert(detectWebImageRequest("Generate an image of a kitten") === false, "WEBIMG_NEG_GENERATE");
assert(detectWebImageRequest("compile the latest npm images") === false, "WEBIMG_NEG_NO_VERB");
assert(detectWebImageRequest("the image is blurry") === false, "WEBIMG_NEG_BLURRY");
assert(detectWebImageRequest("") === false, "WEBIMG_NEG_EMPTY");

// An image-result ask is NOT itself a freshness signal (router adds it).
assert(hasFreshnessSignal("show me images of cats") === false, "WEBIMG_NOT_FRESHNESS");

// ===========================================================================
// C. Location — sanitize, links, near-me phrases (never raw coords out)
// ===========================================================================
const coarse = sanitizeUserLocation({ latitude: 12.3456789, longitude: -98.7654321, accuracy: 1234 });
assert(coarse !== null, "LOC_SANITIZED_PRESENT");
assertEqual(coarse!.latitude, 12.35, "LOC_LAT_ROUNDED_2DP");
assertEqual(coarse!.longitude, -98.77, "LOC_LON_ROUNDED_2DP");
assertEqual(coarse!.accuracy, 1200, "LOC_ACCURACY_ROUND_100M");
assert(sanitizeUserLocation({ latitude: 91, longitude: 0 }) === null, "LOC_LAT_OUT_OF_RANGE");
assert(sanitizeUserLocation({ latitude: 0, longitude: -181 }) === null, "LOC_LON_OUT_OF_RANGE");
assert(sanitizeUserLocation({ latitude: 0, longitude: 0, accuracy: -5 }) !== null, "LOC_BAD_ACCURACY_OK");
assertEqual(
  sanitizeUserLocation({ latitude: NaN, longitude: 0 }),
  null,
  "LOC_NAN_REJECTED"
);
assertEqual(sanitizeUserLocation(null), null, "LOC_NULL_REJECTED");
assertEqual(sanitizeUserLocation(undefined), null, "LOC_UNDEFINED_REJECTED");

const link = buildGoogleMapsSearchLink(coarse!);
assert(link.startsWith("https://www.google.com/maps/search/?api=1&query="), "LOC_LINK_HTTPS_OMNIBOX");
assert(link.includes("12.35"), "LOC_LINK_PIN_LAT");
assert(link.includes("-98.77"), "LOC_LINK_PIN_LON");

assert(nearMePhrase("restaurants near me") === true, "NEAR_ME_PHRASE");
assert(nearMePhrase("what is around here?") === true, "AROUND_HERE_PHRASE");
assert(nearMePhrase("closest pharmacy please") === true, "CLOSEST_PHRASE");
assert(nearMePhrase("how far is the airport") === true, "HOW_FAR_PHRASE");
assert(nearMePhrase("nearby coffee shops") === true, "NEARBY_PHRASE");
assert(nearMePhrase("describe this photo") === false, "NEAR_ME_NEG_DESCRIBE");

// ===========================================================================
// D. Tavily images — include_images opt-in + safe normalization
// ===========================================================================
(async () => {
  const originalFetch = globalThis.fetch;

  // include_images is only sent when requested.
  let capturedBody: unknown = null;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          results: [
            {
              url: "https://images.example.com/cat.jpg",
              title: "Cat results",
              content: "A cat.",
              score: 0.8,
            },
          ],
          images: [
            "https://images.example.com/cat1.jpg",
            "https://images.example.com/cat2.jpg",
            "data:image/png;base64,AAAA", // non-https must be dropped
          ],
          image_descriptions: ["A tabby cat", "A black cat", ""],
        }),
    }) as unknown as Promise<Response>;
  }) as unknown as typeof fetch;

  const without = await searchTavilyWithImages("cats", { apiKey: "k", includeImages: false });
  assert(without !== null && without.images.length === 0, "TALIVY_NO_IMAGES_WHEN_OPT_IN_FALSE");
  assert((capturedBody as { include_images?: boolean }).include_images === false, "TALIVY_OPTOUT_BODY");

  const withImages = await searchTavilyWithImages("cats", { apiKey: "k", includeImages: true });
  assert(withImages !== null, "TALIVY_WITH_IMAGES_RAN");
  assertEqual(withImages!.images.length, 2, "TALIVY_IMAGES_NORMALIZED_AND_FILTERED");
  assertEqual(withImages!.images[0].url, "https://images.example.com/cat1.jpg", "TALIVY_IMAGE_URL_PRESERVED");
  assertEqual(withImages!.images[0].title, "A tabby cat", "TALIVY_IMAGE_TITLE_FROM_DESCRIPTION");
  assert((capturedBody as { include_images?: boolean }).include_images === true, "TALIVY_OPTIN_BODY");

  globalThis.fetch = originalFetch;
})().then(async () => {
  // ===========================================================================
  // E. Control frames carry web images (server → client contract)
  // ===========================================================================
  {
    const research = {
      sources: [
        { index: 1, title: "Cats", url: "https://cats.example.com", domain: "cats.example.com", publishedAt: null },
      ],
      evidence: [{ sourceIndex: 1, sourceTitle: "Cats", url: "https://cats.example.com", passage: "Cats are cats.", publishedAt: null }],
      images: [
        { url: "https://images.example.com/c.png", title: "A cat" },
        { url: "data:image/png;base64,0", title: "evil" },
      ],
      degraded: false,
      status: "ok",
    };
    const frame = buildSourcesControlFrame(research);
    const parsed = parseSourcesControlFrame(frame);
    assert(parsed !== null, "FRAME_WEB_PARSED");
    if (parsed) {
      assertEqual(parsed.images.length, 1, "FRAME_WEB_IMAGES_CARRIED_HTTPS_ONLY");
      assertEqual(parsed.images[0].url, "https://images.example.com/c.png", "FRAME_WEB_IMAGE_URL");
    }

    const hybrid = buildHybridControlFrame({
      webSources: research.sources,
      documentCitations: [{ sourceId: "d-1", sourceName: "notes.pdf", page: 3 }],
      images: research.images,
      degraded: false,
    });
    const hParsed = parseHybridControlFrame(hybrid);
    assert(hParsed !== null, "FRAME_HYBRID_PARSED");
    if (hParsed) {
      assertEqual(hParsed.images.length, 1, "FRAME_HYBRID_IMAGES_FILTERED");
      assertEqual(hParsed.documentCitations.length, 1, "FRAME_HYBRID_DOCS_KEPT");
    }
  }

  // ===========================================================================
  // F. researchWeb — force (intent-driven) + includeImages aggregation
  // ===========================================================================
  {
    const nonForced = await researchWeb("show me images of cats");
    assertEqual(nonForced.sources.length, 0, "RESEARCH_NO_FRESHNESS_NO_FORCE_EMPTY");
    assertEqual(nonForced.status, "no-research-needed", "RESEARCH_NO_FRESHNESS_STATUS");
    assertEqual(nonForced.images.length, 0, "RESEARCH_EMPTY_IMAGES");

    const originalFetch = globalThis.fetch;
    process.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [
              { url: "https://a.example.com/cats", title: "Cats", content: "Cats info.", score: 0.9 },
              { url: "https://b.example.com/cats", title: "More", content: "More cats.", score: 0.8 },
            ],
            images: ["https://img.example.com/c1.jpg", "https://img.example.com/c2.jpg"],
            image_descriptions: ["Cat one", "Cat two"],
          }),
      }) as unknown as Promise<Response>) as unknown as typeof fetch;

    const forced = await researchWeb("show me images of cats", {
      force: true,
      includeImages: true,
    });
    assert(forced.sources.length > 0, "RESEARCH_FORCE_RAN_WITHOUT_FRESHNESS");
    assertEqual(forced.images.length, 2, "RESEARCH_IMAGES_AGGREGATED");
    assertEqual(forced.images[0].title, "Cat one", "RESEARCH_IMAGE_CAPTION_KEPT");

    globalThis.fetch = originalFetch;
    delete process.env.TAVILY_API_KEY;
  }

  // ===========================================================================
  // G. Router — image+web and web-image turns (branch 7C/7F)
  // ===========================================================================
  {
    const upload = { key: "upload" };

    const buyWeb = routeQuery({
      userId: "u1",
      message: "Where can I buy this product online?",
      hasSources: false,
      images: [upload],
    });
    assertEqual(buyWeb.primaryRoute, "WEB_RESEARCH", "ROUTER_IMG_WEB_BUY_ROUTE");
    assertEqual(buyWeb.requiresWeb, true, "ROUTER_IMG_WEB_REQUIRES_WEB");

    // The SAME turn without a fresh upload must NOT research.
    const buyNoImage = routeQuery({
      userId: "u1",
      message: "Where can I buy this product online?",
      hasSources: false,
      images: [],
    });
    assertEqual(buyNoImage.primaryRoute, "GENERAL", "ROUTER_NO_IMAGE_NO_WEB");
    assertEqual(buyNoImage.requiresWeb, false, "ROUTER_NO_IMAGE_REQUIRES_WEB_FALSE");

    const findInfo = routeQuery({
      userId: "u1",
      message: "Find information about this object.",
      hasSources: false,
      images: [upload],
    });
    assertEqual(findInfo.primaryRoute, "WEB_RESEARCH", "ROUTER_IMG_FIND_INFO_ROUTE");
    assertEqual(findInfo.requiresWeb, true, "ROUTER_IMG_FIND_INFO_WEB");

    // Web-image request needs no camera at all.
    const webImgs = routeQuery({ userId: "u1", message: "show me images of cats", hasSources: false });
    assertEqual(webImgs.primaryRoute, "WEB_RESEARCH", "ROUTER_WEB_IMAGE_ROUTE");
    assertEqual(webImgs.requiresWeb, true, "ROUTER_WEB_IMAGE_WEB");

    // Vision-only turns must NOT be hijacked into web research.
    const describe = routeQuery({
      userId: "u1",
      message: "describe this photo",
      hasSources: false,
      images: [upload],
    });
    assertEqual(describe.primaryRoute, "GENERAL", "ROUTER_DESCRIBE_NOT_WEB");
    assertEqual(describe.requiresWeb, false, "ROUTER_DESCRIBE_REQUIRES_WEB_FALSE");

    const whatIs = routeQuery({
      userId: "u1",
      message: "What is this?",
      hasSources: false,
      images: [upload],
    });
    assertEqual(whatIs.primaryRoute, "GENERAL", "ROUTER_WHATIS_NOT_WEB");

    // Freshness turns keep working without images.
    const fresh = routeQuery({ userId: "u1", message: "What is the latest React version?", hasSources: false });
    assertEqual(fresh.primaryRoute, "WEB_RESEARCH", "ROUTER_FRESHNESS_STILL_WEB");
  }

  // ===========================================================================
  // H. Precedence — generation / document turns are never hijacked by 7F web
  // ===========================================================================
  {
    const gen = routeQuery({
      userId: "u1",
      message: "draw a red bicycle",
      hasSources: false,
      images: [{ key: "upload" }],
    });
    assertEqual(gen.primaryRoute, "IMAGE_GENERATION", "ROUTER_GEN_WINS_OVER_WEB");
    assertEqual(gen.requiresWeb, false, "ROUTER_GEN_NO_WEB");

    const docWithWebAsk = routeQuery({
      userId: "u1",
      message: "show me images about photosynthesis",
      hasSources: true,
      sourceCount: 1,
      images: [{ key: "upload" }],
    });
    assertEqual(docWithWebAsk.primaryRoute, "DOCUMENT_RAG", "ROUTER_DOC_WINS_OVER_WEB_IMAGE");
  }

  // Summary
  console.log("--------------------------------------------------");
  console.log(`Phase 7F tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("Phase 7F test suite FAILED");
    process.exitCode = 1;
  } else {
    console.log("Phase 7F test suite PASSED");
  }
});