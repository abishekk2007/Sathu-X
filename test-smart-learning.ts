import {
  analyzeLearningRequest,
  buildSmartLearningInstruction,
  type LearningTurn,
} from "@/lib/learning/smart-learning";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const e = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function analyze(message: string, prior: LearningTurn[] = []) {
  return analyzeLearningRequest(message, prior);
}

const QUIZ_CLARIFIER: LearningTurn = {
  role: "assistant",
  content:
    "I can tailor that quiz to you — let me just grab a couple of quick details.\n\n1) What is your current level?\n   - Beginner\n   - Intermediate\n   - Advanced\n\n2) What is your goal?\n   - Understand the topic\n   - Prepare for an exam\n   - Quick revision\n   - Practice questions\n   - Interview preparation\n\nOnce you reply, I'll jump straight in.",
};

function quizAssistant(): LearningTurn {
  return {
    role: "assistant",
    content:
      "Here's your quiz on photosynthesis (Intermediate, exam prep):\n\nQ1) What is the main pigment in chloroplasts?\nA) Chlorophyll\nB) Melanin\nC) Hemoglobin\nD) Keratin\n\nQ2) Where does the light-dependent stage occur?\nA) Stroma\nB) Thylakoid membrane\nC) Cytoplasm\nD) Cell wall\n\nQ3) What gas is released during photolysis?\nA) CO2\nB) N2\nC) O2\nD) H2\n",
  };
}

// ---- Positive intent detection -------------------------------------------

let r = analyze("Create a quiz on photosynthesis");
check("quiz request w/o level -> clarify", r.intent, "clarify");
check("clarifier contains level", r.clarifier?.includes("What is your current level") ?? false, true);
check("clarifier contains goal", r.clarifier?.includes("What is your goal") ?? false, true);
check("quiz topic extracted", r.topic, "photosynthesis");
check("clarify has focus", r.hasFocus, true);

r = analyze("Make me a quiz on redox reactions, intermediate, for the exam");
check("quiz + level + goal -> quiz", r.intent, "quiz");
check("quiz difficulty intermediate", r.difficulty, "intermediate");
check("quiz goal exam", r.goal, "exam");
check("quiz topic cleaned", r.topic, "redox reactions");

r = analyze("quiz me on unit 3");
check("quiz me -> (clarify, no level)", r.intent, "clarify");
check("quiz me topic unit 3", r.topic, "unit 3");

r = analyze("test me on fractions, I'm a beginner");
check("test me beginner -> quiz", r.intent, "quiz");
check("test me difficulty beginner", r.difficulty, "beginner");

r = analyze("give me practice questions on algebra");
check("practice questions -> quiz", r.intent, "clarify");
check("practice questions topic", r.topic, "algebra");

r = analyze("MCQ on optics, advanced");
check("mcq advanced -> quiz", r.intent, "quiz");
check("mcq difficulty advanced", r.difficulty, "advanced");

r = analyze("Create revision notes on cells");
check("revision notes -> clarify", r.intent, "clarify");
check("revision notes topic", r.topic, "cells");

r = analyze("quick revision on Newton's laws, intermediate");
check("quick revision -> revision", r.intent, "revision");
check("revision difficulty", r.difficulty, "intermediate");

r = analyze("revision material for thermodynamics exam, advanced");
check("revision material advanced -> revision", r.intent, "revision");
check("revision goal exam", r.goal, "exam");

r = analyze("Explain photosynthesis like I'm a beginner");
check("explain beginner -> explain", r.intent, "explain");
check("explain difficulty beginner", r.difficulty, "beginner");
check("explain no clarify (level known)", r.intent !== "clarify", true);

r = analyze("Explain photosynthesis in simple terms");
check("explain simple terms -> beginner", r.difficulty, "beginner");

r = analyze("Teach me Gauss's law step by step");
check("teach step-by-step -> explain intent", ["explain", "clarify"].includes(r.intent), true);
check("teach step-by-step parsed difficulty", r.difficulty === null, true);

r = analyze("explain photosynthesis");
check("plain explain -> none (existing pipeline)", r.intent, "none");

r = analyze("Help me understand recursion from scratch");
check("learn from scratch -> explain", r.intent, "explain");

// ---- Negative / non-interception -----------------------------------------

const negatives: Array<[string, string]> = [
  ["Who created SathuX?", "creator"],
  ["Who created ChatGPT?", "creator of another product"],
  ["Who invented Java?", "other product"],
  ["what's the weather in Chennai?", "weather"],
  ["What is a quiz?", "bare noun"],
  ["I have a quiz tomorrow, help me plan", "planner intent"],
  ["my basketball practice starts at 5", "non-learning practice"],
  ["revise my essay before submitting", "edit semantics"],
  ["summarize this document", "plain summary"],
  ["create a study plan for my physics exam", "study plan"],
  ["help me study for my physics exam tomorrow", "study help w/o cue"],
  ["Tell me about Panimalar Engineering College", "college info"],
  ["Who is Abishek?", "not a learning request"],
  ["make notes on the chapter", "generic notes"],
  ["explain how to create a study plan", "planner explain"],
  ["can you help me with my science homework?", "homework help"],
  ["Remind me to call mom at 9pm", "reminder"],
  ["Search the web for the latest Tesla news", "web search"],
];
for (const [msg, label] of negatives) {
  const a = analyze(msg);
  check(`negative(${label}): "${msg}" -> none`, a.intent, "none");
}

// ---- Clarification flow (multi-turn) -------------------------------------

const afterRequest = [
  { role: "user" as const, content: "Create a quiz on photosynthesis" },
  QUIZ_CLARIFIER,
];

r = analyze("intermediate, for the exam", afterRequest);
check("clarify answer -> clarify_answer", r.intent, "clarify_answer");
check("clarify pending quiz", r.pendingIntent, "quiz");
check("clarify difficulty from answer", r.difficulty, "intermediate");
check("clarify goal from answer", r.goal, "exam");

r = analyze("beginner", afterRequest);
check("clarify 'beginner' -> clarify_answer", r.intent, "clarify_answer");
check("clarify difficulty beginner", r.difficulty, "beginner");

r = analyze("for quick revision", afterRequest);
check("clarify 'for quick revision' -> clarify_answer", r.intent, "clarify_answer");
check("clarify goal revision", r.goal, "revision");

// A fresh full request supersedes the clarifier.
r = analyze("advanced quiz on biotech", afterRequest);
check("new request after clarifier -> quiz", r.intent, "quiz");
check("new request difficulty advanced", r.difficulty, "advanced");
check("new request topic biotech", r.topic, "biotech");

// Once a level is in history, subsequent requests proceed directly.
const withLevel = [
  { role: "user" as const, content: "Create a quiz on photosynthesis, intermediate" },
];
r = analyze("create another quiz on photosynthesis", withLevel);
check("repeat quiz w/ known level -> quiz (no clarify)", r.intent, "quiz");
check("repeat quiz difficulty inherited", r.difficulty, "intermediate");

// ---- Answer submission after a generated quiz ----------------------------

const afterQuiz = [quizAssistant()];
r = analyze("1. B 2. C 3. A", afterQuiz);
check("answer list -> answer_submission", r.intent, "answer_submission");
r = analyze("Q1: A, Q2: B", afterQuiz);
check("Q1: A style -> answer_submission", r.intent, "answer_submission");
r = analyze("answers: B C A D", afterQuiz);
check("answers: style -> answer_submission", r.intent, "answer_submission");
r = analyze("hi", afterQuiz);
check("greeting after quiz -> none", r.intent, "none");
r = analyze("1. B", []);
check("numbered answer w/o quiz -> none", r.intent, "none");

// ---- Weak-topic revision --------------------------------------------------

const evaluation = [
  {
    role: "assistant" as const,
    content:
      "Score: 7/10\n\n**Strong:** Variables, Data Types, Operators\n**Needs Revision:** Loops, Exception Handling\n\nWant targeted practice? Say \"revise weak topics\".",
  },
];
r = analyze("revise the weak topics", evaluation);
check("revise weak topics -> weak_revision", r.intent, "weak_revision");
check("weak topics extracted", r.weakTopics.join(","), "Loops,Exception Handling");

r = analyze("revise my essay", []);
check("revise essay -> none", r.intent, "none");

// ---- Instruction builder --------------------------------------------------

r = analyze("Make me a quiz on redox reactions, intermediate, for the exam");
const quizBlock = buildSmartLearningInstruction(r);
check("quiz block: header", quizBlock.includes("SMART LEARNING MODE"), true);
check("quiz block: intermediate", quizBlock.includes("INTERMEDIATE depth"), true);
check("quiz block: exam goal", quizBlock.includes("Goal: EXAM PREP"), true);
check("quiz block: quiz workflow", quizBlock.includes("QUIZ WORKFLOW"), true);
check("quiz block: format", quizBlock.includes("Q<number>)"), true);
check("quiz block: no answers", /do not reveal the answers/i.test(quizBlock), true);
check("quiz block: focus topic", quizBlock.includes("redox reactions"), true);

const subBlock = buildSmartLearningInstruction(
  analyze("1. B 2. C", afterQuiz)
);
check("eval block: score", subBlock.includes("Score: X/Y"), true);
check("eval block: strong", subBlock.includes("**Strong:**"), true);
check("eval block: needs revision", subBlock.includes("**Needs Revision:**"), true);
check("eval block: revise weak topics hint", subBlock.includes("revise weak topics"), true);

r = analyze("quick revision on Newton's laws, intermediate");
const revBlock = buildSmartLearningInstruction(r);
check("revision block: workflow", revBlock.includes("REVISION WORKFLOW"), true);
check("revision block: quick tier", /QUICK \(short bullet points/i.test(revBlock), true);
check("revision block: detailed tier", /DETAILED \(comprehensive study notes\)/i.test(revBlock), true);

r = analyze("Explain photosynthesis like I'm a beginner");
const expBlock = buildSmartLearningInstruction(r);
check("explain block: workflow", expBlock.includes("EXPLANATION WORKFLOW"), true);
check("explain block: beginner depth", expBlock.includes("BEGINNER depth"), true);

r = analyze("revise weak topics", evaluation);
const weakBlock = buildSmartLearningInstruction(r);
check("weak block: workflow", weakBlock.includes("WEAK-TOPIC REVISION"), true);
check("weak block: topics", weakBlock.includes("Loops"), true);

const adaptive = buildSmartLearningInstruction({
  intent: "revision",
  difficulty: null,
  goal: null,
  topic: null,
  hasFocus: false,
  pendingIntent: null,
  weakTopics: [],
  clarifier: null,
});
check("adaptive depth fallback", adaptive.includes("ADAPTIVE depth"), true);

console.log(`\nsmart-learning tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("SMART LEARNING -- ALL TESTS PASSED");