import { detectCreatorProfileQuestion } from "@/lib/app/profile";

let passed = 0;
let failed = 0;

function check(label: string, actual: string, expected: string) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const positive = [
  ["Who created SathuX?", "creator_question"],
  ["Who invented SathuX?", "creator_question"],
  ["Who is the creator of SathuX?", "creator_question"],
  ["Who made SathuX?", "creator_question"],
  ["who developed SathuX?", "creator_question"],
  ["who built sathux?", "creator_question"],
  ["Who is Abishek K?", "creator_name"],
  ["Tell me about Abishek K.", "creator_name"],
  ["Who is abishek k?", "creator_name"],
  ["What projects has Abishek K worked on?", "project_question"],
  ["What projects has the creator of SathuX worked on?", "project_question"],
  ["Who created this bot?", "creator_question"],
  ["Who built this app?", "creator_question"],
  ["Who developed this chatbot?", "creator_question"],
];

for (const [msg, expected] of positive) {
  const r = detectCreatorProfileQuestion(msg);
  check(`Positive: "${msg}" -> ${expected}`, r.type, expected);
}

const negative = [
  "Who created ChatGPT?",
  "Who invented Gemini?",
  "Who created Google?",
  "Who created OpenAI?",
  "What is the weather in Chennai?",
  "Help me write a study plan",
  "Who created this PDF?",
  "Who created this document?",
  "What projects have I worked on?",
  "Who invented Java?",
  "Tell me about artificial intelligence",
  "Summarize my notes",
  "What does my PDF say about photosynthesis?",
  "Search the web for the latest Tesla news",
  "Create a study plan for my physics exam",
  "Remind me to call mom at 9pm",
  "Can you help with my science homework?",
];

for (const msg of negative) {
  const r = detectCreatorProfileQuestion(msg);
  check(`Negative: "${msg}" -> none`, r.type, "none");
}

console.log(`\ncreator-profile tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("CREATOR PROFILE -- ALL TESTS PASSED");
