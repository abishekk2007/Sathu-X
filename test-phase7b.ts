// ---------------------------------------------------------------------------
// Automated tests for Phase 7B Voice Output (pure helpers only).
// Run with: npx tsx test-phase7b.ts
//
// The browser-native speechSynthesis hook (src/hooks/use-speech-synthesis.ts)
// cannot run in Node without jsdom, but its deterministic text logic lives in
// src/lib/speech-output.ts and is fully covered here.
//
// TEST 1  - SPEAKABLE_EMPTY:      empty/whitespace-only text is not speakable
// TEST 2  - SPEAKABLE_TEXT:       real text is speakable
// TEST 3  - PLAIN_TEXT:           plain prose passes through unchanged
// TEST 4  - BOLD_ITALIC:          **bold** / *italic* / _under_ stripped
// TEST 5  - INLINE_CODE:          `code` becomes bare text, no backticks
// TEST 6  - LINK:                 [label](url) becomes the label only
// TEST 7  - STRIKETHROUGH:        ~~strike~~ stripped
// TEST 8  - HEADING:              # markers removed
// TEST 9  - HEADING_WITH_TEXT:    "# Heading" keeps the heading words
// TEST 10 - CODE_BLOCK:           fenced code is omitted with a notice
// TEST 11 - CODE_BLOCK_EMPTY:     empty fence adds no "omitted" notice
// TEST 12 - LIST:                 "- item" / "1. item" become natural item text
// TEST 13 - BLOCKQUOTE:           "> quote" becomes quote text
// TEST 14 - TABLE:                separators relaxed; cells kept (single line)
// TEST 15 - MULTILINE:            paragraphs collapse to one spaced string
// TEST 16 - EMPTY_INPUT:          empty string -> "" (never speaks nothing)
// TEST 17 - CODE_BLOCK_TO_PLAIN:  code after block still read naturally
// TEST 18 - TIDY_WHITESPACE:      runs of spaces collapse to a single space
// ---------------------------------------------------------------------------

import {
  markdownToSpeechText,
  hasSpeakableText,
  tidySpokenLine,
  CODE_BLOCK_OMITTED_PHRASE,
} from "./src/lib/speech-output";

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

function contains(haystack: string, needle: string, label: string) {
  assert(haystack.includes(needle), label);
}

// TEST 1
assert(hasSpeakableText("") === false, "SPEAKABLE_EMPTY");
assert(hasSpeakableText("   \n\t ") === false, "SPEAKABLE_WHITESPACE");
assert(hasSpeakableText(null) === false, "SPEAKABLE_NULL");
assert(hasSpeakableText(undefined) === false, "SPEAKABLE_UNDEFINED");

// TEST 2
assert(hasSpeakableText("Hello!") === true, "SPEAKABLE_TEXT");
assert(hasSpeakableText("   hi  ") === true, "SPEAKABLE_TEXT_TRIMMED");

// TEST 3
assert(
  markdownToSpeechText("Hello world.") === "Hello world.",
  "PLAIN_TEXT"
);

// TEST 4
contains(markdownToSpeechText("This is **bold** and *italic* and _under_."), "bold", "BOLD");
contains(markdownToSpeechText("This is **bold** and *italic* and _under_."), "italic", "ITALIC");
assert(
  markdownToSpeechText("This is **bold** and *italic* and _under_.").includes("**") === false,
  "BOLD_NODELIMS"
);

// TEST 5
assert(
  markdownToSpeechText("Use `npm install` here.").includes("`") === false,
  "INLINE_CODE_NOBACKTICK"
);
contains(markdownToSpeechText("Use `npm install` here."), "npm install", "INLINE_CODE_TEXT");

// TEST 6
const linkText = markdownToSpeechText("See [the docs](https://example.com) now.");
contains(linkText, "the docs", "LINK_LABEL");
assert(linkText.includes("https://") === false, "LINK_NO_URL");

// TEST 7
const strikeText = markdownToSpeechText("This ~~is gone~~ now.");
contains(strikeText, "now", "STRIKE_TEXT");
assert(strikeText.includes("~~") === false, "STRIKE_NODELIMS");

// TEST 8
assert(
  markdownToSpeechText("## Intro").includes("#") === false,
  "HEADING_NOHASH"
);

// TEST 9
contains(markdownToSpeechText("# Big News"), "Big News", "HEADING_WITH_TEXT");

// TEST 10
const codeText = markdownToSpeechText(
  "Here's how:\n```ts\nconst x = 1;\nconsole.log(x);\n```\nThat's it."
);
contains(codeText, CODE_BLOCK_OMITTED_PHRASE, "CODE_BLOCK_OMITTED_PHRASE");
assert(codeText.includes("const x = 1") === false, "CODE_BLOCK_BODY_OMITTED");
contains(codeText, "Here's how", "CODE_BLOCK_LEADING_TEXT");

// TEST 11
const emptyFenceText = markdownToSpeechText("text``` ```tail");
// The empty fence body adds no "omitted" notice.
assert(
  emptyFenceText.includes(CODE_BLOCK_OMITTED_PHRASE) === false,
  "CODE_BLOCK_EMPTY_NO_NOTICE"
);

// TEST 12
contains(markdownToSpeechText("- apples\n- pears"), "apples", "LIST_DASH_ITEM");
contains(markdownToSpeechText("- apples\n- pears"), "pears", "LIST_DASH_SECOND");
contains(markdownToSpeechText("1. first\n2. second"), "first", "LIST_OL_ITEM");
assert(
  markdownToSpeechText("- apples").includes("-") === false,
  "LIST_DASH_REMOVED"
);

// TEST 13
contains(markdownToSpeechText("> wise words"), "wise words", "BLOCKQUOTE_TEXT");
assert(
  markdownToSpeechText("> wise words").includes(">") === false,
  "BLOCKQUOTE_REMOVED"
);

// TEST 14
const tableText = markdownToSpeechText("| A | B |\n|---|---|\n| 1 | 2 |");
// Cell content survives; the separator row is relaxed, not spoken as pipes.
contains(tableText, "A", "TABLE_HEADER_A");
contains(tableText, "2", "TABLE_CELL");
assert(tableText.includes("---") === false, "TABLE_SEPARATOR_RELAXED");

// TEST 15
const multiText = markdownToSpeechText("One sentence.\n\nAnother paragraph.");
contains(multiText, "One sentence.", "MULTILINE_FIRST");
contains(multiText, "Another paragraph.", "MULTILINE_SECOND");

// TEST 16
assert(markdownToSpeechText("") === "", "EMPTY_INPUT");
assert(markdownToSpeechText("   ") === "", "WHITESPACE_INPUT");

// TEST 17
const blockThenText = markdownToSpeechText("```js\nx();\n```\nThen plain.");
contains(blockThenText, "Then plain.", "CODE_BLOCK_TO_PLAIN_PRESERVED");

// TEST 18
assert(
  tidySpokenLine("a    b\t\tc") === "a b c",
  "TIDY_WHITESPACE"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
