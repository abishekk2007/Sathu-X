// ---------------------------------------------------------------------------
// Automated tests for Phase 7A Voice Input (pure helpers only).
// Run with: npx tsx test-phase7a.ts
//
// The browser-native Web Speech hook (src/hooks/use-speech-recognition.ts)
// cannot run in Node without jsdom, but its deterministic logic lives in
// src/lib/speech.ts and is fully covered here.
//
// TEST 1  - DURATION_ZERO:       0 -> "0:00"
// TEST 2  - DURATION_SECONDS:    under a minute formats M:SS zero-padded
// TEST 3  - DURATION_MINUTES:    minutes roll over (75 -> "1:15")
// TEST 4  - DURATION_HOURS:      long durations keep M:SS form (3600 -> "60:00")
// TEST 5  - DURATION_NEGATIVE:   negative clamps to "0:00"
// TEST 6  - DURATION_FRACTION:   fractional seconds floors
// TEST 7  - ERROR_NOT_ALLOWED:   maps to friendly permission copy
// TEST 8  - ERROR_NETWORK:       maps to friendly network copy
// TEST 9  - ERROR_NO_SPEECH:     maps to friendly no-speech copy
// TEST 10 - ERROR_AUDIO_CAPTURE: maps to friendly no-mic copy
// TEST 11 - ERROR_SERVICE:       maps to friendly service copy
// TEST 12 - ERROR_UNKNOWN:       falls back to generic copy
// ---------------------------------------------------------------------------

import { formatDuration, speechErrorMessage } from "./src/lib/speech";

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

// TEST 1
assert(formatDuration(0) === "0:00", "DURATION_ZERO");

// TEST 2
assert(formatDuration(7) === "0:07", "DURATION_SECONDS");
assert(formatDuration(59) === "0:59", "DURATION_SECONDS_99");

// TEST 3
assert(formatDuration(75) === "1:15", "DURATION_MINUTES");

// TEST 4
assert(formatDuration(3600) === "60:00", "DURATION_HOURS");
assert(formatDuration(3661) === "61:01", "DURATION_HOURS_EXTRA");

// TEST 5
assert(formatDuration(-5) === "0:00", "DURATION_NEGATIVE");

// TEST 6
assert(formatDuration(9.9) === "0:09", "DURATION_FRACTION_FLOOR");
assert(formatDuration(Number.NaN) === "0:00", "DURATION_NAN_SAFE");

// TEST 7
const msgNotAllowed = speechErrorMessage("not-allowed");
assert(
  msgNotAllowed.includes("denied") &&
    msgNotAllowed.includes("allow microphone access"),
  "ERROR_NOT_ALLOWED"
);

// TEST 8
const msgNetwork = speechErrorMessage("network");
assert(
  msgNetwork.includes("network error") &&
    msgNetwork.includes("internet connection"),
  "ERROR_NETWORK"
);

// TEST 9
const msgNoSpeech = speechErrorMessage("no-speech");
assert(
  msgNoSpeech.includes("No speech") && msgNoSpeech.includes("try again"),
  "ERROR_NO_SPEECH"
);

// TEST 10
const msgAudio = speechErrorMessage("audio-capture");
assert(
  msgAudio.includes("microphone") && msgAudio.includes("connect"),
  "ERROR_AUDIO_CAPTURE"
);

// TEST 11
const msgService = speechErrorMessage("service-not-allowed");
assert(
  msgService.includes("service is not allowed"),
  "ERROR_SERVICE"
);

// TEST 12
const msgUnknown = speechErrorMessage("some-other-error");
assert(
  msgUnknown.includes("some-other-error"),
  "ERROR_UNKNOWN_FALLBACK"
);

// The error mapper must produce a deterministic, user-readable string for
// every code the hook may emit (the hook itself filters out "aborted" before
// it reaches this mapper).
const allMessages = ["not-allowed", "network", "no-speech", "audio-capture", "service-not-allowed", "unknown", "aborted"]
  .map((code) => speechErrorMessage(code));
assert(
  allMessages.every((msg) => typeof msg === "string" && msg.length > 0),
  "ERROR_MAP_ALL_CODES_STRING"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
