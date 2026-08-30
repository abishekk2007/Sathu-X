import type {
  AiMode,
  Conversation,
  NotificationItem,
  Reminder,
  SpideyDocument,
  StudyActivity,
  StudySubject,
  Task,
} from "@/types";

/**
 * DEMO DATA ONLY.
 * Everything in this file is static mock data used to demonstrate the UI.
 * It will be replaced by Supabase-backed services without changing the
 * component contracts (see src/types/index.ts).
 */

export const mockUser = {
  name: "Abishek K",
  email: "abishek@spideybot.app",
  initials: "AK",
};

export const mockSuggestions: { id: string; title: string; prompt: string; icon: string }[] = [
  {
    id: "s1",
    title: "Explain a difficult concept",
    prompt: "Explain eigenvalues and eigenvectors like I'm new to linear algebra.",
    icon: "lightbulb",
  },
  {
    id: "s2",
    title: "Create a study plan",
    prompt: "Create a 7-day study plan for my Engineering Physics exam.",
    icon: "calendar",
  },
  {
    id: "s3",
    title: "Summarize my notes",
    prompt: "Summarize the notes I uploaded about operating systems.",
    icon: "notebook",
  },
  {
    id: "s4",
    title: "Help me write code",
    prompt: "Write a C program that reverses a linked list, with comments.",
    icon: "code",
  },
  {
    id: "s5",
    title: "Plan my day",
    prompt: "Plan my day around two lectures and a physics revision block.",
    icon: "sun",
  },
  {
    id: "s6",
    title: "Ask me anything",
    prompt: "Give me five quick quiz questions on C pointers.",
    icon: "sparkles",
  },
];

const quantumAnswer = `## Quantum computing, in one minute

A classical bit is a coin lying flat — **heads or tails**. A qubit is a coin *spinning*: until you look, it is a blend of both.

Three ideas power quantum computers:

- **Superposition** — a qubit holds many states at once
- **Entanglement** — qubits link so measuring one tells you about the other
- **Interference** — wrong answers cancel out, right ones reinforce

> Think of it as exploring a maze by walking every path simultaneously, then keeping only the exits.

\`\`\`python
# A qubit in superposition (Qiskit)
from qiskit import QuantumCircuit

qc = QuantumCircuit(1)
qc.h(0)          # Hadamard: |0> -> (|0> + |1>) / √2
\`\`\`

Want me to go deeper into entanglement or how algorithms use interference?`;

const linkedListAnswer = `Here's a clean three-pointer reversal:

\`\`\`c
#include <stdio.h>
#include <stdlib.h>

struct Node {
    int data;
    struct Node *next;
};

struct Node *reverse(struct Node *head) {
    struct Node *prev = NULL;
    while (head != NULL) {
        struct Node *next = head->next; /* save */
        head->next = prev;              /* flip  */
        prev = head;                    /* move  */
        head = next;
    }
    return prev;
}
\`\`\`

### How it works

1. \`prev\` trails behind as the reversed list grows
2. Each node's \`next\` is flipped to point backward
3. When \`head\` reaches NULL, \`prev\` is the new head

Time complexity is **O(n)** with **O(1)** extra space. Want a version that reverses in groups of k?`;

const studyPlanAnswer = `## Your 7-day Physics plan

**Mon** · Unit 2 recap — electrostatics · 90 min
**Tue** · Numerical problem sets · 2 h
**Wed** · Magnetism concepts + notes · 90 min
**Thu–Sat** · Past papers, one section per day · 90 min each
**Sun** · Full mock test + review · 2 h

### How to use it

- Start each session with 10 minutes of active recall
- End every session by writing 3 flashcards
- Day 7 is reserved for a full mock test

I've kept evenings light so revision stays consistent. Shall I turn this into reminders?`;

const defaultAnswer = `Good question — here's the short version:

- **Core idea:** break the problem into what you know and what you're solving for
- **Why it matters:** it keeps the reasoning verifiable instead of hand-wavy
- **Next step:** try a small example end-to-end before scaling up

Want a deeper explanation, an example, or a quick quiz to check understanding?`;

const errorAnswer =
  "Something went wrong while generating this response. This is a simulated demo error.";

function assistant(content: string, timeLabel: string): Conversation["messages"][number] {
  return { id: `m-${Math.abs(hash(content))}`, role: "assistant", content, timeLabel, status: "complete" };
}

function user(content: string, timeLabel: string): Conversation["messages"][number] {
  return { id: `m-${Math.abs(hash(content))}u`, role: "user", content, timeLabel };
}

/** Tiny deterministic hash so mock message ids are stable between server and client. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h << 5) - h + value.charCodeAt(i);
    h |= 0;
  }
  return h;
}

export const mockConversations: Conversation[] = [
  {
    id: "c1",
    title: "Explain quantum computing",
    mode: "general",
    group: "today",
    messages: [
      user("Explain quantum computing like I'm 15.", "4:12 PM"),
      assistant(quantumAnswer, "4:12 PM"),
    ],
  },
  {
    id: "c2",
    title: "Create my study plan",
    mode: "student",
    group: "today",
    messages: [
      user("Make me a 7-day plan for the Engineering Physics exam.", "11:38 AM"),
      assistant(studyPlanAnswer, "11:39 AM"),
    ],
  },
  {
    id: "c3",
    title: "Physics Unit 2 revision",
    mode: "student",
    group: "yesterday",
    messages: [
      user("Quiz me on electrostatics, 5 questions.", "8:20 PM"),
      assistant(defaultAnswer, "8:21 PM"),
    ],
  },
  {
    id: "c4",
    title: "C programming assignment",
    mode: "general",
    group: "previous-7-days",
    messages: [
      user("Write a C function that reverses a linked list.", "6:04 PM"),
      assistant(linkedListAnswer, "6:05 PM"),
    ],
  },
  {
    id: "c5",
    title: "Resume improvement",
    mode: "assistant",
    group: "older",
    messages: [
      user("Improve the summary line on my resume.", "Mon"),
      assistant(defaultAnswer, "Mon"),
    ],
  },
];

export const mockDemoResponses: Record<string, string> = {
  code: linkedListAnswer,
  study: studyPlanAnswer,
  default: defaultAnswer,
  quantum: quantumAnswer,
  error: errorAnswer,
};

export const mockDocuments: SpideyDocument[] = [
  {
    id: "d1",
    name: "Engineering Physics — Unit 2.pdf",
    type: "pdf",
    sizeLabel: "2.4 MB",
    dateLabel: "Today",
    status: "ready",
  },
  {
    id: "d2",
    name: "Operating Systems Notes.docx",
    type: "docx",
    sizeLabel: "860 KB",
    dateLabel: "Today",
    status: "ready",
  },
  {
    id: "d3",
    name: "Matrices & Calculus — Problem Set.txt",
    type: "txt",
    sizeLabel: "42 KB",
    dateLabel: "Yesterday",
    status: "processing",
  },
  {
    id: "d4",
    name: "Communication English Journal.pdf",
    type: "pdf",
    sizeLabel: "1.1 MB",
    dateLabel: "Yesterday",
    status: "ready",
  },
  {
    id: "d5",
    name: "Whiteboard — Fourier Series.jpg",
    type: "jpg",
    sizeLabel: "3.2 MB",
    dateLabel: "Aug 18",
    status: "ready",
  },
  {
    id: "d6",
    name: "Chemistry Lab Manual Scan.png",
    type: "png",
    sizeLabel: "5.8 MB",
    dateLabel: "Aug 14",
    status: "failed",
  },
];

export const mockDocumentSummary: Record<string, { summary: string[] }> = {
  d1: {
    summary: [
      "Unit 2 covers electrostatics: Coulomb's law, electric fields, flux, and Gauss's theorem.",
      "Key derivations appear in sections 2.3–2.5 with worked examples.",
      "Two solved numerical patterns repeat across past exam papers.",
    ],
  },
};

export const mockTasks: Task[] = [
  {
    id: "t1",
    title: "Revise Physics Unit 2",
    dueLabel: "Today",
    priority: "high",
    category: "Study",
    completed: false,
  },
  {
    id: "t2",
    title: "Complete C assignment",
    dueLabel: "Tomorrow",
    priority: "medium",
    category: "Assignment",
    completed: false,
  },
  {
    id: "t3",
    title: "Generate quiz from OS notes",
    dueLabel: "Today",
    priority: "low",
    category: "Study",
    completed: false,
  },
  {
    id: "t4",
    title: "Email professor about project topic",
    dueLabel: "Tomorrow",
    priority: "high",
    category: "Personal",
    completed: false,
  },
  {
    id: "t5",
    title: "Review flashcards — Calculus",
    dueLabel: "Fri, Aug 21",
    priority: "medium",
    category: "Study",
    completed: true,
  },
  {
    id: "t6",
    title: "Back up lecture recordings",
    dueLabel: "Thu, Aug 20",
    priority: "low",
    category: "Personal",
    completed: true,
  },
];

export const mockReminders: Reminder[] = [
  {
    id: "r1",
    title: "Study Physics — Unit 2",
    dayLabel: "Today",
    timeLabel: "7:00 PM",
    completed: false,
  },
  {
    id: "r2",
    title: "Submit C assignment draft",
    dayLabel: "Today",
    timeLabel: "9:30 PM",
    completed: false,
  },
  {
    id: "r3",
    title: "Morning review — flashcards",
    dayLabel: "Tomorrow",
    timeLabel: "7:30 AM",
    completed: false,
  },
  {
    id: "r4",
    title: "Library session — Calculus",
    dayLabel: "Tomorrow",
    timeLabel: "5:00 PM",
    completed: false,
  },
  {
    id: "r5",
    title: "Weekly plan with Spidey Bot",
    dayLabel: "Sun, Aug 23",
    timeLabel: "10:00 AM",
    completed: true,
  },
];

export const mockStudySubjects: StudySubject[] = [
  {
    id: "sub1",
    name: "C Programming",
    progress: 82,
    nextTopic: "Pointers & dynamic memory",
  },
  {
    id: "sub2",
    name: "Engineering Physics",
    progress: 64,
    nextTopic: "Unit 2 — Electrostatics revision",
  },
  {
    id: "sub3",
    name: "Matrices & Calculus",
    progress: 71,
    nextTopic: "Eigenvalues revision",
  },
  {
    id: "sub4",
    name: "Communication English",
    progress: 58,
    nextTopic: "Presentation skills draft",
  },
];

export const mockStudyActivities: StudyActivity[] = [
  { id: "a1", action: "Generated a quiz", subject: "Operating Systems", timeLabel: "25 min ago" },
  { id: "a2", action: "Summarized notes", subject: "Engineering Physics — Unit 2", timeLabel: "2 h ago" },
  { id: "a3", action: "Explained a concept", subject: "Matrices & Calculus", timeLabel: "Yesterday" },
  { id: "a4", action: "Practiced flashcards", subject: "C Programming", timeLabel: "Yesterday" },
];

export const mockNotifications: NotificationItem[] = [
  {
    id: "n1",
    kind: "reminder",
    title: "Study reminder",
    body: "Physics revision starts in 30 minutes.",
    timeLabel: "Just now",
    unread: true,
  },
  {
    id: "n2",
    kind: "goal",
    title: "Study goal",
    body: "You're 20 minutes away from today's goal.",
    timeLabel: "1 h ago",
    unread: true,
  },
  {
    id: "n3",
    kind: "document",
    title: "Document ready",
    body: "Your Operating Systems notes are ready to analyze.",
    timeLabel: "3 h ago",
    unread: false,
  },
];

export const mockFlashcards: { id: string; question: string; answer: string }[] = [
  {
    id: "f1",
    question: "What does a pointer store?",
    answer: "The memory address of another variable.",
  },
  {
    id: "f2",
    question: "Define an eigenvector.",
    answer:
      "A nonzero vector v where A·v = λ·v — it only scales under the transform A.",
  },
  {
    id: "f3",
    question: "State Coulomb's law.",
    answer:
      "F = k·q₁q₂/r² — force between charges is proportional to their product, inversely to distance squared.",
  },
  {
    id: "f4",
    question: "What is time complexity of binary search?",
    answer: "O(log n) — the search space halves each step.",
  },
];

export const mockModes: { value: AiMode; label: string }[] = [
  { value: "general", label: "General" },
  { value: "student", label: "Student" },
  { value: "assistant", label: "Assistant" },
];

export interface StudyToolField {
  kind: "input" | "textarea" | "select";
  label: string;
  placeholder?: string;
  options?: string[];
}

export interface StudyTool {
  id: string;
  title: string;
  description: string;
  icon: "notebook" | "summarize" | "quiz" | "exam" | "explain" | "plan";
  cta: string;
  fields: StudyToolField[];
}

export const mockStudyTools: StudyTool[] = [
  {
    id: "ask-notes",
    title: "Ask from Notes",
    description: "Question-answer over your uploaded notes.",
    icon: "notebook",
    cta: "Ask notes",
    fields: [
      { kind: "select", label: "Document", options: ["Engineering Physics — Unit 2.pdf", "Operating Systems Notes.docx"] },
      { kind: "input", label: "Your question", placeholder: "e.g. What does Gauss's theorem state?" },
    ],
  },
  {
    id: "summarize",
    title: "Summarize",
    description: "Condense long notes into key ideas.",
    icon: "summarize",
    cta: "Summarize",
    fields: [
      { kind: "textarea", label: "Paste your notes", placeholder: "Paste the notes you want summarized..." },
      { kind: "select", label: "Length", options: ["Short", "Medium", "Detailed"] },
    ],
  },
  {
    id: "quiz",
    title: "Generate Quiz",
    description: "Practice questions from any topic.",
    icon: "quiz",
    cta: "Create quiz",
    fields: [
      { kind: "select", label: "Subject", options: ["C Programming", "Engineering Physics", "Matrices & Calculus"] },
      { kind: "select", label: "Difficulty", options: ["Easy", "Medium", "Hard"] },
      { kind: "select", label: "Questions", options: ["5", "10", "15"] },
    ],
  },
  {
    id: "exam-answer",
    title: "Exam Answer",
    description: "Marks-weighted answers for exam prep.",
    icon: "exam",
    cta: "Draft answer",
    fields: [
      { kind: "select", label: "Subject", options: ["Engineering Physics", "Matrices & Calculus", "Communication English"] },
      { kind: "select", label: "Marks", options: ["2 marks", "5 marks", "10 marks"] },
      { kind: "select", label: "Answer style", options: ["Bullet points", "Paragraph"] },
    ],
  },
  {
    id: "explain",
    title: "Explain Concept",
    description: "Clear explanations at your pace.",
    icon: "explain",
    cta: "Explain it",
    fields: [
      { kind: "textarea", label: "Topic", placeholder: "Paste a topic or concept you're stuck on" },
      { kind: "select", label: "Depth", options: ["Simple", "Balanced", "In-depth"] },
    ],
  },
  {
    id: "study-plan",
    title: "Study Plan",
    description: "A realistic plan around your week.",
    icon: "plan",
    cta: "Build plan",
    fields: [
      { kind: "input", label: "Subjects & exams", placeholder: "e.g. Physics Unit 2 test on Friday" },
      { kind: "select", label: "Plan length", options: ["3 days", "7 days", "14 days"] },
    ],
  },
];

export const mockToolResults: Record<string, string> = {
  "ask-notes":
    "### From your Physics notes\n\nGauss's theorem states that the total electric flux through a closed surface equals **1/ε₀** times the net charge enclosed.\n\n- Works for any closed surface\n- Most useful when charge distribution is symmetric\n\nSource: *Engineering Physics — Unit 2.pdf*, section 2.3.",
  summarize:
    "### Summary\n\n- **Main idea:** the passage connects load balancing to OS scheduling concepts\n- **Key terms:** round-robin, priority inversion, context switching\n- **Takeaway:** scheduling fairness matters more than raw speed in shared systems",
  quiz:
    "### Quick quiz · C Programming · Medium\n\n1. What does `malloc` return on failure?\n2. Difference between `*ptr++` and `(*ptr)++`?\n3. Why can't you return a pointer to a local variable?\n4. What does the `const` keyword guarantee here: `const int *p`?\n5. Time complexity of inserting at the head of a linked list?\n\n*(Answers unlock after submission once grading is wired up.)*",
  "exam-answer":
    "**Q. State and prove Gauss's theorem. (5 marks)**\n\n**Statement (1 mark):** total flux through a closed surface equals 1/ε₀ times enclosed charge.\n\n**Proof sketch (3 marks):** consider a point charge inside a sphere — flux integral evaluates to q/ε₀; by solid-angle argument the result is independent of surface shape.\n\n**Conclusion (1 mark):** hence proved, applicable to arbitrary closed surfaces.",
  explain:
    "### Eigenvalues, simply\n\nThink of a matrix as a *transformation*. Most vectors get knocked off their line when transformed — but a few special ones only stretch or shrink.\n\n- Those special vectors are **eigenvectors**\n- The stretch factor is the **eigenvalue λ**\n\nFormally: **A·v = λ·v** for nonzero v.",
  "study-plan":
    "### Your 3-day plan\n\n**Day 1** · Gauss's theorem derivations + 5 numericals (90 min)\n**Day 2** · Past-paper section A timed (60 min) + review misses (30 min)\n**Day 3** · Full mock + flashcard sweep (90 min)\n\nEach session ends with 3 self-written flashcards.",
};
