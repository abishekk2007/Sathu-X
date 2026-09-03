// ---------------------------------------------------------------------------
// Automated tests for Phase 7E Camera Understanding (pure helpers).
// Run with: npx tsx test-phase7e.ts
//
// The browser camera hook (src/hooks/use-camera.ts) cannot run in Node
// without a DOM, but its deterministic logic lives in pure helpers that ARE
// fully covered here:
//   - src/lib/camera.ts        (capability, errors, MIME/size policy,
//                               normalization math, state machine, cleanup)
//   - src/lib/camera-parts.ts  (server-side Gemini inline part assembly)
//
// TEST 1  - MIME validation
// TEST 2  - image size validation
// TEST 3  - image normalization rules
// TEST 4  - camera capability detection
// TEST 5  - permission error mapping
// TEST 6  - unsupported browser handling
// TEST 7  - stream cleanup
// TEST 8  - attachment creation
// TEST 9  - camera state transitions
// TEST 10 - retake behavior
// TEST 11 - use-photo behavior
// TEST 12 - empty prompt behavior
// TEST 13 - multimodal request construction
// TEST 14 - image + text request
// TEST 15 - image-only request
// TEST 16 - malformed image rejection
// TEST 17 - no image data logging
// TEST 18 - existing text-only path remains unchanged
// TEST 19 - capture uses intrinsic video dimensions (not CSS layout dims)
// TEST 20 - capture guards (no-video / no-frame / zero dims) never draw→encode
// TEST 21 - capture draw hands the video frame to the canvas at intrinsic size
// TEST 22 - captured data URL validity (non-empty, jpeg/png/webp)
// TEST 23 - capture → retake → capture lifecycle stays correct
// ---------------------------------------------------------------------------

import {
  cameraSupported,
  cameraErrorMessage,
  cameraReducer,
  CAMERA_INITIAL_UI,
  CAMERA_IMAGE_MAX_BYTES,
  CAMERA_IMAGE_MAX_DIMENSION,
  computeScaledDimensions,
  isCameraImageWithinSize,
  isCameraMimeSupported,
  mapCameraError,
  stopAllTracks,
  buildCameraAttachment,
  resolveSendPrompt,
  resolveCaptureFrame,
  drawVideoFrameIntoCanvas,
  beginPhotoCapture,
  isValidCapturedDataUrl,
  CAMERA_HAVE_CURRENT_DATA,
} from "./src/lib/camera";
import {
  buildInlineImagePart,
  buildCameraMessageParts,
} from "./src/lib/camera-parts";
import { validateImage } from "./src/lib/multimodal/image-processing";

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

// TEST 1 — MIME validation
assert(isCameraMimeSupported("image/jpeg"), "MIME_JPEG_ACCEPTED");
assert(isCameraMimeSupported("image/png"), "MIME_PNG_ACCEPTED");
assert(isCameraMimeSupported("image/webp"), "MIME_WEBP_ACCEPTED");
assert(!isCameraMimeSupported("text/plain"), "MIME_TEXT_REJECTED");
assert(!isCameraMimeSupported("application/pdf"), "MIME_PDF_REJECTED");
assert(!isCameraMimeSupported("image/gif"), "MIME_GIF_REJECTED");
assert(!isCameraMimeSupported("image/svg+xml"), "MIME_SVG_REJECTED");
assert(!isCameraMimeSupported(""), "MIME_EMPTY_REJECTED");
assert(isCameraMimeSupported("image/jpeg ".toUpperCase()), "MIME_WHITESPACE_NORMALIZED");

// TEST 2 — image size validation
assert(isCameraImageWithinSize(1000), "SIZE_SMALL_OK");
assert(isCameraImageWithinSize(CAMERA_IMAGE_MAX_BYTES), "SIZE_AT_LIMIT_OK");
assert(!isCameraImageWithinSize(CAMERA_IMAGE_MAX_BYTES + 1), "SIZE_OVER_LIMIT");
assert(!isCameraImageWithinSize(0), "SIZE_ZERO_REJECTED");
assert(!isCameraImageWithinSize(-5), "SIZE_NEGATIVE_REJECTED");
assert(!isCameraImageWithinSize(Number.NaN), "SIZE_NAN_REJECTED");

// TEST 3 — image normalization rules
const scaled = computeScaledDimensions(4000, 3000, CAMERA_IMAGE_MAX_DIMENSION);
assert(scaled.width === 1600 && scaled.height === 1200, "NORMALIZE_LANDSCAPE_1600");
assert(
  computeScaledDimensions(1000, 2000, CAMERA_IMAGE_MAX_DIMENSION).height === 1600,
  "NORMALIZE_PORTRAIT_CAPS_LONGEST"
);
assert(
  computeScaledDimensions(800, 600, CAMERA_IMAGE_MAX_DIMENSION).width === 800,
  "NORMALIZE_ALREADY_SMALL_UNCHANGED"
);
assert(
  computeScaledDimensions(800, 600, CAMERA_IMAGE_MAX_DIMENSION).height === 600,
  "NORMALIZE_HEIGHT_UNCHANGED"
);
const tiny = computeScaledDimensions(0, 0, CAMERA_IMAGE_MAX_DIMENSION);
assert(tiny.width >= 1 && tiny.height >= 1, "NORMALIZE_ZERO_CLAMPS");
const portrait = computeScaledDimensions(3000, 4000, CAMERA_IMAGE_MAX_DIMENSION);
assert(portrait.width === 1200 && portrait.height === 1600, "NORMALIZE_ASPECT_PRESERVED");

// TEST 4 — camera capability detection
assert(cameraSupported(() => undefined) === true, "CAPABILITY_SUPPORTED");
assert(cameraSupported(undefined) === false, "CAPABILITY_UNDEFINED");
assert(cameraSupported(null) === false, "CAPABILITY_NULL");
assert(cameraSupported("nope") === false, "CAPABILITY_NON_FUNCTION");

// TEST 5 — permission error mapping
assert(mapCameraError({ name: "NotAllowedError" }) === "permission-denied", "ERROR_NOT_ALLOWED");
assert(mapCameraError({ name: "PermissionDeniedError" }) === "permission-denied", "ERROR_PERMISSION_DENIED");
assert(mapCameraError({ name: "NotFoundError" }) === "no-camera", "ERROR_NOT_FOUND");
assert(mapCameraError({ name: "DevicesNotFoundError" }) === "no-camera", "ERROR_DEVICES_NOT_FOUND");
assert(mapCameraError({ name: "NotReadableError" }) === "start-failed", "ERROR_NOT_READABLE");
assert(mapCameraError({ name: "TrackStartError" }) === "start-failed", "ERROR_TRACK_START");
assert(mapCameraError({ name: "OverconstrainedError" }) === "start-failed", "ERROR_OVERCONSTRAINED");
assert(mapCameraError({ name: "SecurityError" }) === "insecure-context", "ERROR_SECURITY");
assert(mapCameraError({ name: "SomethingWeird" }) === "unknown", "ERROR_UNKNOWN");
assert(mapCameraError(undefined) === "unknown", "ERROR_UNDEFINED");
assert(mapCameraError({ name: "TypeError" }) === "start-failed", "ERROR_TYPEOF_ILINVOCATION_START_FAILED");
assert(
  cameraErrorMessage(mapCameraError({ name: "TypeError" })).includes("start"),
  "ERROR_MESSAGE_TYPEOF_FRIENDLY"
);
assert(
  !cameraErrorMessage(mapCameraError({ name: "TypeError" })).includes("TypeError"),
  "ERROR_MESSAGE_TYPEOF_NO_RAW_TYPE"
);
assert(
  cameraErrorMessage(mapCameraError({ name: "NotAllowedError" })).includes("denied"),
  "ERROR_MESSAGE_DENIED_FRIENDLY"
);
assert(
  !cameraErrorMessage(mapCameraError({ name: "NotAllowedError" })).includes("NotAllowedError"),
  "ERROR_MESSAGE_NO_RAW_CODE"
);

// TEST 6 — unsupported browser handling
assert(
  cameraErrorMessage("not-supported").includes("doesn't support camera"),
  "UNSUPPORTED_FRIENDLY"
);
assert(
  cameraErrorMessage("insecure-context").includes("HTTPS"),
  "UNSUPPORTED_INSECURE_CONTEXT_FRIENDLY"
);

// TEST 7 — stream cleanup
let stopped1 = 0;
let stopped2 = 0;
stopAllTracks([
  { stop: () => { stopped1 += 1; } },
  { stop: () => { stopped2 += 1; } },
]);
assert(stopped1 === 1 && stopped2 === 1, "STREAM_ALL_STOPPED");
stopAllTracks(null);
stopAllTracks([]);
stopAllTracks([{ stop: undefined as unknown as () => void }]);
assert(true, "STREAM_EMPTY_SAFE");
stopAllTracks([
  { stop: () => { stopped1 += 1; } },
  { stop: () => { stopped1 += 1; } },
]);
assert(stopped1 === 3, "STREAM_REPEAT_STOPS_EACH");

// TEST 8 — attachment creation
const attachment = buildCameraAttachment({
  dataUrl: "data:image/jpeg;base64,AAEC",
  mimeType: "image/jpeg",
  name: "Camera photo",
  width: 1600,
  height: 1200,
  sizeBytes: 2048,
});
assert(attachment.mimeType === "image/jpeg", "ATTACHMENT_MIME");
assert(attachment.width === 1600 && attachment.height === 1200, "ATTACHMENT_DIMENSIONS");
assert(attachment.sizeBytes === 2048, "ATTACHMENT_SIZE");
assert(attachment.name === "Camera photo", "ATTACHMENT_NAME");
assert(
  buildCameraAttachment({ dataUrl: "x", mimeType: "image/png", width: 1, height: 1, sizeBytes: 1 }).name === "Camera photo",
  "ATTACHMENT_DEFAULT_NAME"
);

// TEST 9 — camera state transitions
const afterOpen = cameraReducer(CAMERA_INITIAL_UI, { type: "open_request" });
assert(afterOpen.state === "requesting", "STATE_OPEN_REQUEST");
const afterSuccess = cameraReducer(afterOpen, { type: "open_success" });
assert(afterSuccess.state === "active", "STATE_OPEN_SUCCESS");
const afterCapture = cameraReducer(afterSuccess, { type: "capture_success" });
assert(afterCapture.state === "captured", "STATE_CAPTURE_SUCCESS");
const afterUse = cameraReducer(afterCapture, { type: "use_photo" });
assert(afterUse.state === "idle", "STATE_USE_PHOTO");
const errState = cameraReducer(CAMERA_INITIAL_UI, { type: "error", message: "test" });
assert(errState.state === "error" && errState.error === "test", "STATE_ERROR_CARRIES_MESSAGE");
assert(cameraReducer(CAMERA_INITIAL_UI, { type: "close" }).state === "idle", "STATE_CLOSE");

// TEST 10 — retake behavior (discard + re-request)
const retakeState = cameraReducer(afterCapture, { type: "retake" });
assert(retakeState.state === "requesting", "RETAKE_RESETS_TO_REQUESTING");
assert(retakeState.error === null, "RETAKE_CLEARS_ERROR");

// TEST 11 — use-photo behavior (resolves to idle, camera stopped separately)
const useState = cameraReducer(afterCapture, { type: "use_photo" });
assert(useState.state === "idle", "USE_PHOTO_TO_IDLE");
assert(useState.error === null, "USE_PHOTO_CLEARS_ERROR");

// TEST 12 — empty prompt behavior
assert(resolveSendPrompt("", true) === "Describe this image.", "EMPTY_PROMPT_WITH_IMAGE_DEFAULT");
assert(resolveSendPrompt("   ", true) === "Describe this image.", "EMPTY_PROMPT_WHITESPACE_DEFAULT");
assert(resolveSendPrompt("", false) === "", "EMPTY_PROMPT_NO_IMAGE_EMPTY");
assert(resolveSendPrompt("What is this plant?", true) === "What is this plant?", "TEXT_WITH_IMAGE_PRESERVED");
assert(resolveSendPrompt("  Solve it  ", true) === "Solve it", "TEXT_TRIMMED");

// TEST 13 — multimodal request construction
const part = buildInlineImagePart(Buffer.from("hello"), "image/jpeg");
assert(part.inlineData.mimeType === "image/jpeg", "PART_MIME");
assert(part.inlineData.data === Buffer.from("hello").toString("base64"), "PART_BASE64");
assert(typeof part.inlineData.data === "string" && part.inlineData.data.length > 0, "PART_DATA_STRING");
assert(!part.inlineData.data.includes("\n"), "PART_NO_NEWLINES_IN_DATA");

// TEST 14 — image + text request
const imagePart = buildInlineImagePart(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
const composed = buildCameraMessageParts("Solve this math problem", imagePart.inlineData);
assert(composed.length === 2, "PARTS_TEXT_PLUS_IMAGE_COUNT");
assert(
  composed[0] && "text" in composed[0] && composed[0].text === "Solve this math problem",
  "PARTS_TEXT_FIRST"
);
assert(
  composed[1] && "inlineData" in composed[1] && composed[1].inlineData.mimeType === "image/jpeg",
  "PARTS_IMAGE_SECOND"
);

// TEST 15 — image-only request (default prompt supplied upstream)
const imageOnly = buildCameraMessageParts("Describe this image.", imagePart.inlineData);
assert(imageOnly.length === 2, "IMAGE_ONLY_PARTS_2");
assert(
  imageOnly[0] && "text" in imageOnly[0] && imageOnly[0].text === "Describe this image.",
  "IMAGE_ONLY_TEXT_IS_DEFAULT"
);

// TEST 16 — malformed image rejection (server-side magic-byte validation)
const malformed = validateImage(Buffer.from("definitely not an image"), "image/jpeg", {
  maxImageSizeBytes: 1024 * 1024,
  maxImageDimension: 10000,
});
assert(!malformed.ok, "MALFORMED_REJECTED");

// TEST 17 — no image data logging
const logs: unknown[][] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { logs.push(args); };
try {
  buildCameraAttachment({
    dataUrl: "data:image/png;base64,HIDDENBYTES",
    mimeType: "image/png",
    name: "private-photo",
    width: 100,
    height: 100,
    sizeBytes: 50,
  });
  buildInlineImagePart(Buffer.from("secret-bytes"), "image/png");
  cameraErrorMessage("permission-denied");
} finally {
  console.log = originalLog;
}
assert(logs.length === 0, "NO_IMAGE_DATA_LOGGED");

// TEST 18 — existing text-only path remains unchanged
const textOnly = buildCameraMessageParts("hello world", undefined);
assert(textOnly.length === 1, "TEXT_ONLY_ONE_PART");
assert(
  textOnly[0] && "text" in textOnly[0] && textOnly[0].text === "hello world",
  "TEXT_ONLY_CONTENT_PRESERVED"
);
assert(!("inlineData" in textOnly[0]!), "TEXT_ONLY_NO_IMAGE_PART");

// TEST 19 — capture uses intrinsic video dimensions, never CSS layout dims.
// The old capture silently drew from a stale (null) element, skipped drawImage,
// then encoded a fallback 1280×720 blank canvas → black frame. The corrected
// path reads intrinsic media dimensions and NEVER the CSS-sized layout values.
const intrinsicVideo = {
  readyState: 4,
  videoWidth: 1920,
  videoHeight: 1080,
  // CSS layout size — larger than the media frame in a different way, and
  // would produce a stretched/wrong capture if ever consulted.
  clientWidth: 300,
  clientHeight: 150,
};
const dimsRecorder: { dims: { width: number; height: number } | null } = { dims: null };
const readyAttempt = beginPhotoCapture(intrinsicVideo, (_v, width, height) => {
  dimsRecorder.dims = { width, height };
});
assert(readyAttempt.status === "ready", "CAPTURE_RESOLVES_READY");
assert(
  readyAttempt.status === "ready" &&
    readyAttempt.videoWidth === 1920 &&
    readyAttempt.videoHeight === 1080,
  "CAPTURE_INTRINSIC_DIMS_RESOLVED"
);
assert(dimsRecorder.dims !== null, "CAPTURE_FRAME_DRAWN_FOR_READY");
assert(
  dimsRecorder.dims?.width === 1920 && dimsRecorder.dims?.height === 1080,
  "CAPTURE_USES_INTRINSIC_NOT_CLIENT_DIMS"
);
assert(
  beginPhotoCapture(intrinsicVideo, () => {}).status === "ready",
  "CAPTURE_READY_AT_HAVE_CURRENT_DATA"
);
assert(
  resolveCaptureFrame({ readyState: CAMERA_HAVE_CURRENT_DATA, videoWidth: 640, videoHeight: 480 })
    .status === "ready",
  "CAPTURE_READYSTATE_THRESHOLD_ACCEPTED"
);

// TEST 20 — capture guards. Missing/undecoded/zero-size sources must resolve to
// a controlled reason WITHOUT drawing (so a black canvas can never be encoded).
const oldBlackFallback = beginPhotoCapture(null, () => {});
assert(oldBlackFallback.status === "no-video", "CAPTURE_NO_VIDEO_RESOLVED");
// The OLD implementation fell back to 1280×720 and encoded a blank (black)
// canvas when no element was bound. The fixed gate never invents fallback
// dims for a missing/undecoded source.
const producedBlackFallback =
  (oldBlackFallback.status === "ready" && oldBlackFallback.videoWidth === 1280) ||
  (oldBlackFallback.status === "ready" && oldBlackFallback.videoHeight === 720);
assert(!producedBlackFallback, "CAPTURE_NO_SILENT_1280x720_BLACK_FALLBACK");
let nullDraws = 0;
beginPhotoCapture(null, () => { nullDraws += 1; });
assert(nullDraws === 0, "CAPTURE_NO_VIDEO_NEVER_DRAWS");

let noDataDraws = 0;
const noDataAttempt = beginPhotoCapture(
  { readyState: 1, videoWidth: 1920, videoHeight: 1080 },
  () => { noDataDraws += 1; }
);
assert(noDataAttempt.status === "no-frame", "CAPTURE_NO_CURRENT_DATA_RESOLVED");
assert(noDataDraws === 0, "CAPTURE_NO_CURRENT_DATA_NEVER_DRAWS");
assert(
  resolveCaptureFrame({ readyState: 1, videoWidth: 1920, videoHeight: 1080 }).status === "no-frame",
  "CAPTURE_NOT_YET_HAVE_DATA_REJECTED"
);

let zeroDimsDraws = 0;
const zeroDimsAttempt = beginPhotoCapture(
  { readyState: 4, videoWidth: 0, videoHeight: 0 },
  () => { zeroDimsDraws += 1; }
);
assert(zeroDimsAttempt.status === "no-frame", "CAPTURE_ZERO_DIMS_RESOLVED");
assert(zeroDimsDraws === 0, "CAPTURE_ZERO_DIMS_NEVER_DRAWS");
assert(
  resolveCaptureFrame({ readyState: 4, videoWidth: 1920, videoHeight: 0 }).status === "no-frame",
  "CAPTURE_PARTIAL_DIMS_REJECTED"
);

// TEST 21 — canvas receives the actual video frame at intrinsic size.
const recorded: unknown[][] = [];
const recordingCtx = {
  drawImage: (...args: unknown[]) => { recorded.push(args); },
} as unknown as CanvasRenderingContext2D;
const drew = drawVideoFrameIntoCanvas(recordingCtx, intrinsicVideo as unknown as HTMLVideoElement, 1920, 1080);
assert(drew === true, "CAPTURE_CANVAS_DRAWN");
assert(recorded.length === 1, "CAPTURE_CANVAS_DRAW_ONCE");
assert(
  recorded[0]?.[0] === intrinsicVideo &&
    recorded[0]?.[1] === 0 &&
    recorded[0]?.[2] === 0 &&
    recorded[0]?.[3] === 1920 &&
    recorded[0]?.[4] === 1080,
  "CAPTURE_CANVAS_RECEIVES_FRAME_AT_INTRINSIC_DIMS"
);
assert(
  drawVideoFrameIntoCanvas(recordingCtx, null, 1920, 1080) === false,
  "CAPTURE_DRAW_REJECTS_NO_VIDEO"
);

// TEST 22 — captured data URL validity (non-empty, expected prefix/MIME).
assert(isValidCapturedDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg"), "CAPTURE_DATAURL_VALID");
assert(isValidCapturedDataUrl("data:image/png;base64,iVBORw0KGgo"), "CAPTURE_DATAURL_PNG_VALID");
assert(isValidCapturedDataUrl("data:image/webp;base64,UklGRg"), "CAPTURE_DATAURL_WEBP_VALID");
assert(!isValidCapturedDataUrl(""), "CAPTURE_DATAURL_EMPTY_REJECTED");
assert(!isValidCapturedDataUrl("not-a-data-url"), "CAPTURE_DATAURL_NO_PREFIX_REJECTED");
assert(!isValidCapturedDataUrl("data:text/plain;base64,ABC"), "CAPTURE_DATAURL_WRONG_MIME_REJECTED");
assert(!isValidCapturedDataUrl("data:image/gif;base64,R0lGODlh"), "CAPTURE_DATAURL_GIF_REJECTED");
const encodedPayload = Buffer.from(Array.from({ length: 2048 }, () => 7));
const inlinePart = buildInlineImagePart(encodedPayload, "image/jpeg");
assert(
  inlinePart.inlineData.data.length > 0 && inlinePart.inlineData.mimeType === "image/jpeg",
  "CAPTURE_ENCODED_OUTPUT_NONEMPTY"
);

// TEST 23 — capture → retake → capture lifecycle stays correct (regression:
// retake must keep returning to a live preview and capturing again).
let life = CAMERA_INITIAL_UI;
life = cameraReducer(life, { type: "open_request" });
life = cameraReducer(life, { type: "open_success" });
life = cameraReducer(life, { type: "capture_success" });
assert(life.state === "captured", "RETAKE_LOOP_CAPTURED_1");
assert(life.error === null, "RETAKE_LOOP_NO_ERROR_AFTER_CAPTURE");
life = cameraReducer(life, { type: "retake" });
assert(life.state === "requesting", "RETAKE_LOOP_REQUESTING_AGAIN");
life = cameraReducer(life, { type: "open_success" });
life = cameraReducer(life, { type: "capture_success" });
assert(life.state === "captured", "RETAKE_LOOP_CAPTURED_2");

console.log("\n== RESULTS ============================================\n");
console.log(`Phase 7E results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;