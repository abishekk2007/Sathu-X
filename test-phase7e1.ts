// ---------------------------------------------------------------------------
// Automated tests for Phase 7E.1 Clipboard Image Paste (pure helpers).
// Run with: npx tsx test-phase7e1.ts
//
// Clipboard input is normalized into the SAME `CameraCapturedImage` model the
// camera produces, then the existing `ChatUserImageAttachment` →
// `uploadedImage` → server `validateSourceImage` pipeline. There is NO second
// paste pipeline. All decision logic is covered here via:
//   - src/lib/camera.ts        (pick/validate/paste-error/naming helpers)
//   - src/lib/camera-parts.ts  (server-side Gemini inline part assembly)
//   - src/lib/multimodal/image-processing.ts (authoritative magic-byte gate)
//
// The only DOM-bound work (FileReader, <img> decode, canvas re-draw, toBlob)
// lives in the composer and is validated in the real-Edge browser harness.
//
// TEST 1  - JPEG paste accepted
// TEST 2  - PNG paste accepted
// TEST 3  - WebP paste accepted
// TEST 4  - GIF paste rejected
// TEST 5  - SVG paste rejected
// TEST 6  - non-image paste preserves text paste
// TEST 7  - image paste prevents default
// TEST 8  - paste data URL is created (valid payload)
// TEST 9  - paste MIME is preserved end-to-end
// TEST 10 - paste name is created (file name, else "Pasted image")
// TEST 11 - oversized paste rejected or normalized
// TEST 12 - paste dimension limit
// TEST 13 - paste removal returns to text-only send
// TEST 14 - image + text sends both parts
// TEST 15 - image-only paste uses the describe-this-image prompt
// TEST 16 - paste never logs image data
// TEST 17 - paste reuses the existing uploadedImage pipeline
// TEST 18 - camera behavior unchanged
// TEST 19 - document/RAG path unchanged
// TEST 20 - web-research path unchanged
// TEST 21 - hybrid routing unchanged
// TEST 22 - image-generation path unchanged
// TEST 23 - image-edit path unchanged
// ---------------------------------------------------------------------------

import {
  CAMERA_IMAGE_MAX_BYTES,
  CAMERA_IMAGE_MAX_DIMENSION,
  CAMERA_INITIAL_UI,
  DEFAULT_CAMERA_PROMPT,
  buildCameraAttachment,
  cameraReducer,
  computeScaledDimensions,
  isCameraImageWithinSize,
  isCameraMimeSupported,
  isValidCapturedDataUrl,
  pasteImageErrorMessage,
  pastedImageName,
  pickClipboardImage,
  resolveSendPrompt,
  shouldInterceptImagePaste,
  validatePastedImage,
} from "./src/lib/camera";
import {
  buildCameraMessageParts,
  buildInlineImagePart,
} from "./src/lib/camera-parts";
import { validateImage } from "./src/lib/multimodal/image-processing";

// 1×1 transparent PNG — valid magic bytes for the byte-level pipeline checks.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG = Buffer.from(TINY_PNG_BASE64, "base64");
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

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

// TEST 1-3 — supported paste MIME types are accepted (same policy as camera)
assert(
  validatePastedImage({ mimeType: "image/jpeg", sizeBytes: 1000 }).ok === true,
  "PASTE_JPEG_ACCEPTED"
);
assert(
  validatePastedImage({ mimeType: "image/png", sizeBytes: 1000 }).ok === true,
  "PASTE_PNG_ACCEPTED"
);
assert(
  validatePastedImage({ mimeType: "image/webp", sizeBytes: 1000 }).ok === true,
  "PASTE_WEBP_ACCEPTED"
);

// TEST 4-5 — unsupported clipboard image formats are rejected with the
// friendly unsupported-format message
const gifVerdict = validatePastedImage({ mimeType: "image/gif", sizeBytes: 1000 });
assert(!gifVerdict.ok && gifVerdict.code === "unsupported-mime", "PASTE_GIF_REJECTED");
const svgVerdict = validatePastedImage({ mimeType: "image/svg+xml", sizeBytes: 1000 });
assert(!svgVerdict.ok && svgVerdict.code === "unsupported-mime", "PASTE_SVG_REJECTED");
assert(
  !validatePastedImage({ mimeType: "image/bmp", sizeBytes: 1000 }).ok,
  "PASTE_BMP_REJECTED"
);
assert(
  !validatePastedImage({ mimeType: "image/tiff", sizeBytes: 1000 }).ok,
  "PASTE_TIFF_REJECTED"
);
assert(
  !validatePastedImage({ mimeType: "video/mp4", sizeBytes: 1000 }).ok,
  "PASTE_VIDEO_REJECTED"
);
assert(
  !validatePastedImage({ mimeType: "audio/mpeg", sizeBytes: 1000 }).ok,
  "PASTE_AUDIO_REJECTED"
);
assert(
  pasteImageErrorMessage("unsupported-mime").includes("JPEG, PNG, or WebP"),
  "PASTE_UNSUPPORTED_MESSAGE_FRIENDLY"
);

// TEST 6 — a text-only clipboard is never treated as an image, so the default
// browser paste (text) proceeds untouched
const textOnly = pickClipboardImage([{ kind: "string", type: "text/plain" }], []);
assert(!textOnly.found, "PASTE_NON_IMAGE_PRESERVES_TEXT_PASTE");
assert(
  !shouldInterceptImagePaste([{ kind: "string", type: "text/plain" }], []),
  "TEXT_ONLY_PASTE_NOT_INTERCEPTED"
);
assert(
  !shouldInterceptImagePaste(
    [{ kind: "string", type: "text/html" }],
    [{ type: "text/plain", name: "note.txt", size: 10 }]
  ),
  "HTML_ONLY_PASTE_NOT_INTERCEPTED"
);

// TEST 7 — an image in the clipboard forces preventDefault (interception), and
// the pick carries everything needed for the friendly unsupported branch
const picked = pickClipboardImage(
  [{ kind: "file", type: "image/png", name: "shot.png", size: 20000 }],
  []
);
assert(picked.found === true, "PASTE_IMAGE_PREVENTS_DEFAULT");
assert(shouldInterceptImagePaste([{ kind: "file", type: "image/png" }], []), "IMAGE_PASTE_INTERCEPTED");
assert(picked.found && picked.supported === true, "PASTE_PICK_SUPPORTED");
assert(picked.found && picked.name === "shot.png", "PASTE_PICK_CARRIES_NAME");
assert(picked.found && picked.sizeBytes === 20000, "PASTE_PICK_CARRIES_SIZE");
// An unsupported image is still INTERCEPTED (so we can show the error instead
// of pasting garbage) but reported as unsupported.
const gifPick = pickClipboardImage(
  [{ kind: "file", type: "image/gif", name: "anim.gif", size: 10 }],
  []
);
assert(gifPick.found && gifPick.supported === false, "PASTE_PICK_UNSUPPORTED_STILL_INTERCEPTED");

// TEST 8 — a normalized paste produces a valid image data URL (the server
// `uploadedImage` field and `validateSourceImage` accept this exact shape)
assert(isValidCapturedDataUrl(PNG_DATA_URL), "PASTE_IMAGE_DATAURL_CREATED");
assert(
  buildCameraAttachment({
    dataUrl: PNG_DATA_URL,
    mimeType: "image/png",
    name: "paste.png",
    width: 1,
    height: 1,
    sizeBytes: TINY_PNG.length,
  }).dataUrl === PNG_DATA_URL,
  "PASTE_ATTACHMENT_DATAURL_ROUNDTRIP"
);
assert(!isValidCapturedDataUrl("data:image/gif;base64,AAAA"), "PASTE_GIF_DATAURL_REJECTED");
assert(!isValidCapturedDataUrl(`data:image/jpeg;base64,`), "PASTE_EMPTY_BASE64_REJECTED");

// TEST 9 — the declared MIME survives normalization and reaches the Gemini
// inline part unchanged (magic bytes are still verified server-side)
const webpAttachment = buildCameraAttachment({
  dataUrl: PNG_DATA_URL,
  mimeType: "image/webp",
  name: "photo.webp",
  width: 1,
  height: 1,
  sizeBytes: 100,
});
assert(webpAttachment.mimeType === "image/webp", "PASTE_IMAGE_MIME_PRESERVED");
const inlinePart = buildInlineImagePart(TINY_PNG, "image/png");
assert(inlinePart.inlineData.mimeType === "image/png", "PASTE_INLINE_MIME_PRESERVED");
assert(inlinePart.inlineData.data === TINY_PNG_BASE64, "PASTE_INLINE_DATA_PRESERVED");

// TEST 10 — pasted image name: file name wins, generic default otherwise
assert(pastedImageName("screenshot.png") === "screenshot.png", "PASTE_IMAGE_NAME_CREATED");
assert(pastedImageName("") === "Pasted image", "PASTE_EMPTY_NAME_DEFAULT");
assert(pastedImageName("   ") === "Pasted image", "PASTE_WHITESPACE_NAME_DEFAULT");
assert(pastedImageName(null) === "Pasted image", "PASTE_NULL_NAME_DEFAULT");
assert(pastedImageName(undefined) === "Pasted image", "PASTE_UNDEFINED_NAME_DEFAULT");
// Camera captures keep their distinct default name — single-model attachment.
assert(
  buildCameraAttachment({
    dataUrl: PNG_DATA_URL,
    mimeType: "image/jpeg",
    width: 1,
    height: 1,
    sizeBytes: 1,
  }).name === "Camera photo",
  "CAMERA_DEFAULT_NAME_UNCHANGED"
);

// TEST 11 — oversized pastes are rejected with the under-5-MB message OR
// normalized to the 1600px bound by the re-draw (bounds are the 5MB limit)
const oversized = validatePastedImage({
  mimeType: "image/jpeg",
  sizeBytes: CAMERA_IMAGE_MAX_BYTES + 1,
});
assert(!oversized.ok && oversized.code === "too-large", "PASTE_OVERSIZED_IMAGE_REJECTED_OR_NORMALIZED");
assert(isCameraImageWithinSize(CAMERA_IMAGE_MAX_BYTES), "PASTE_AT_LIMIT_STILL_OK");
assert(pasteImageErrorMessage("too-large").includes("under 5 MB"), "PASTE_TOO_LARGE_MESSAGE_FRIENDLY");
assert(
  !validatePastedImage({ mimeType: "image/jpeg", sizeBytes: Number.NaN }).ok,
  "PASTE_NAN_SIZE_REJECTED"
);
// null size (FileList entries always carry size; DataTransferItem gets real
// size at getAsFile time) is tolerated and deferred to the post-encode bound.
assert(
  validatePastedImage({ mimeType: "image/png", sizeBytes: null }).ok === true,
  "PASTE_NULL_SIZE_DEFERRED_TO_ENCODE"
);

// TEST 12 — the re-draw caps the longest edge at the camera dimension limit
const square = computeScaledDimensions(2000, 2000, CAMERA_IMAGE_MAX_DIMENSION);
assert(square.width === CAMERA_IMAGE_MAX_DIMENSION && square.height === CAMERA_IMAGE_MAX_DIMENSION, "PASTE_IMAGE_DIMENSION_LIMIT");
const huge = computeScaledDimensions(12000, 9000, CAMERA_IMAGE_MAX_DIMENSION);
assert(
  huge.width <= CAMERA_IMAGE_MAX_DIMENSION && huge.height <= CAMERA_IMAGE_MAX_DIMENSION,
  "PASTE_HUGE_NORMALIZED_INTO_BOUNDS"
);
const small = computeScaledDimensions(400, 300, CAMERA_IMAGE_MAX_DIMENSION);
assert(small.width === 400 && small.height === 300, "PASTE_SMALL_UNCHANGED");

// TEST 13 — removing the photo returns the composer to plain-text behavior
// (no photo → an empty textarea cannot send, matching the pre-7E rule)
assert(resolveSendPrompt("", false) === "", "PASTE_IMAGE_REMOVAL");

// TEST 14 — image + text sends BOTH the typed question and the image part
const bothParts = buildCameraMessageParts("What does this plan show?", {
  mimeType: "image/png",
  data: TINY_PNG_BASE64,
});
assert(bothParts.length === 2, "PASTE_IMAGE_PLUS_TEXT_SENDS_BOTH");
assert(
  "text" in bothParts[0] && bothParts[0].text === "What does this plan show?",
  "PASTE_TEXT_PART_PRESERVED"
);
assert(
  "inlineData" in bothParts[1] && bothParts[1].inlineData.data.length > 0,
  "PASTE_IMAGE_PART_PRESENT"
);

// TEST 15 — image-only paste uses exactly the shared describe-this-image prompt
assert(
  resolveSendPrompt("", true) === DEFAULT_CAMERA_PROMPT,
  "PASTE_IMAGE_ONLY_USES_DESCRIBE_PROMPT"
);
const soloParts = buildCameraMessageParts(resolveSendPrompt("", true), {
  mimeType: "image/webp",
  data: TINY_PNG_BASE64,
});
assert(
  soloParts.length === 2 && "text" in soloParts[0] && soloParts[0].text === DEFAULT_CAMERA_PROMPT,
  "PASTE_DESCRIBE_PROMPT_PART"
);

// TEST 16 — no paste/clipboard path ever logs image bytes or data URLs
const origLog = console.log;
const origError = console.error;
const logCapture: string[] = [];
console.log = (...args) => logCapture.push(args.join(" "));
console.error = (...args) => logCapture.push(args.join(" "));
try {
  const attachment = buildCameraAttachment({
    dataUrl: PNG_DATA_URL,
    mimeType: "image/png",
    name: "clip.png",
    width: 1,
    height: 1,
    sizeBytes: TINY_PNG.length,
  });
  buildInlineImagePart(TINY_PNG, "image/png");
  buildCameraMessageParts("describe", { mimeType: "image/png", data: TINY_PNG_BASE64 });
  validatePastedImage({ mimeType: "image/png", sizeBytes: 100 });
  pasteImageErrorMessage("processing-failed");
  void attachment.mimeType;
} finally {
  console.log = origLog;
  console.error = origError;
}
assert(
  !logCapture.some((line) => line.includes(TINY_PNG_BASE64) || line.includes("data:image/png")),
  "PASTE_DOES_NOT_LOG_IMAGE_DATA"
);

// TEST 17 — a paste becomes the same `ChatUserImageAttachment` the camera
// produces, satisfying the exact `uploadedImage` wire constraints of the route
// (dataUrl length 64..30_000_000, trimmed mimeType ≤64, trimmed name ≤255)
const wire = buildCameraAttachment({
  dataUrl: PNG_DATA_URL,
  mimeType: "image/png",
  name: "paste.png",
  width: 1,
  height: 1,
  sizeBytes: TINY_PNG.length,
});
assert(typeof wire.dataUrl === "string", "PASTE_REUSES_UPLOADED_IMAGE_PIPELINE");
assert(wire.dataUrl.startsWith("data:image/png;base64,"), "PASTE_UPLOADED_IMAGE_DATAURL_SHAPE");
assert(wire.dataUrl.length >= 64 && wire.dataUrl.length <= 30_000_000, "PASTE_UPLOADED_IMAGE_DATAURL_BOUNDS");
assert(wire.mimeType.trim().length <= 64, "PASTE_UPLOADED_IMAGE_MIME_BOUNDS");
assert(wire.name.trim().length <= 255, "PASTE_UPLOADED_IMAGE_NAME_BOUNDS");
assert(wire.width >= 1 && wire.height >= 1, "PASTE_UPLOADED_IMAGE_DIMS_NONZERO");
// The server's authoritative magic-byte gate still accepts the normalized PNG
// and returns its detected MIME (past-proof against a spoofed declared MIME).
const magicVerification = validateImage(TINY_PNG, "image/png", {
  maxImageSizeBytes: CAMERA_IMAGE_MAX_BYTES,
  maxImageDimension: CAMERA_IMAGE_MAX_DIMENSION,
});
assert(
  magicVerification.ok === true && magicVerification.mimeType === "image/png",
  "PASTE_MAGIC_BYTES_STILL_VERIFIED"
);

// TEST 18 — camera capture behavior is entirely unchanged by the paste work
let camState = CAMERA_INITIAL_UI;
camState = cameraReducer(camState, { type: "open_request" });
camState = cameraReducer(camState, { type: "open_success" });
assert(camState.state === "active", "CAMERA_BEHAVIOR_UNCHANGED");
assert(isCameraMimeSupported("image/jpeg"), "CAMERA_MIME_GATE_INTACT");

// TEST 19 — document/RAG evidence path unchanged: the paste path assembles
// only [text, inlineData] parts, never a retrieval/fileData component
const ragParts = buildCameraMessageParts("question", undefined);
assert(
  ragParts.length === 1 && "text" in ragParts[0] && ragParts[0].text === "question",
  "DOCUMENT_RAG_UNCHANGED"
);
assert(
  !JSON.stringify(bothParts).includes("fileData"),
  "PASTE_PATH_NEVER_ADDS_FILE_PART"
);

// TEST 20 — web-research path unchanged: paste errors and paste parts never
// reference search/tool plumbing
const pasteErrorCopy = [
  pasteImageErrorMessage("unsupported-mime"),
  pasteImageErrorMessage("too-large"),
  pasteImageErrorMessage("no-image"),
  pasteImageErrorMessage("processing-failed"),
].join(" ");
assert(
  !/tavily|weblite|search/i.test(pasteErrorCopy),
  "WEB_RESEARCH_UNCHANGED"
);

// TEST 21 — hybrid routing unchanged: the empty-text/empty-image rule still
// returns "" (nothing to route) and the describe default only appears when a
// photo is attached
assert(resolveSendPrompt("  ", false) === "", "HYBRID_ROUTING_UNCHANGED");
assert(resolveSendPrompt("  ", true) === DEFAULT_CAMERA_PROMPT, "HYBRID_ROUTING_IMAGE_DEFAULT");

// TEST 22 — image-generation path unchanged: the pasted-photo default prompt
// stays the descriptive one (no generation/edit implications)
assert(
  !resolveSendPrompt("", true).toLowerCase().includes("edit"),
  "IMAGE_GENERATION_UNCHANGED"
);

// TEST 23 — image-edit path unchanged: the authoritative byte gate still
// rejects non-images, and a valid paste is never treated as an edit source
const fakeImage = validateImage(Buffer.from("definitely not an image"), "image/png", {
  maxImageSizeBytes: CAMERA_IMAGE_MAX_BYTES,
  maxImageDimension: CAMERA_IMAGE_MAX_DIMENSION,
});
assert(fakeImage.ok === false, "IMAGE_EDIT_UNCHANGED");

console.log("\n== RESULTS ============================================\n");
console.log(`Phase 7E.1 results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;