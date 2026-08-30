# Phase 5A — Agentic Chat Core: Test Plan

## Prerequisites

1. Run migration: `supabase/migrations/20260826010000_phase5a_agentic_chat.sql`
2. Create Supabase Storage bucket `context-sources` (private)
3. User is authenticated

---

## A. Normal Chat (No Sources)

**Test 1:** Ask "What is photosynthesis?" with no sources attached.
**Expected:** Normal Gemini answer. No retrieval. Console log: `agent action=answer_directly`.

**Test 2:** Ask "What is 2 + 2?" in General mode.
**Expected:** Short answer "4". No retrieval.

---

## B. Upload File via [+] Menu — Auto-Processing

**Test 3:** Click `[+]` → "Upload file" → Upload a PDF.
**Expected:** Toast "filename.pdf uploaded — processing...". Source chip appears in composer. File appears in `/documents`.

**Test 4:** After upload completes, ask a question about the uploaded PDF.
**Expected:** Agent auto-processes the document (console log: `auto-processing document...`), retrieves relevant chunks. Answer grounded in document content. Console log: `agent action=retrieve_context`. Source indicator `📄 Source: filename.pdf` at end of answer.

**Test 4b:** Attach a freshly uploaded document that is still in `processing_status: "pending"` or `"uploaded"`.
**Expected:** The chat API auto-triggers `processDocument()` before retrieval. If processing succeeds, the document is retrieved and used. If processing fails (e.g. scanned PDF), the source is skipped gracefully and the chat continues without it.

---

## C. Paste Text via [+] Menu

**Test 5:** Click `[+]` → "Paste text" → Paste "1. What is DBMS?\n2. Explain normalization.\n3. Explain 1NF, 2NF and 3NF." → Save.
**Expected:** Source chip "Pasted notes" appears. Toast "Pasted text added as context".

**Test 6:** Ask "Explain question 3."
**Expected:** Agent retrieves from pasted text. Answer about 1NF, 2NF, 3NF grounded in pasted material. Source indicator `📋 Source: Pasted notes`.

---

## D. Add Image via [+] Menu

**Test 7:** Click `[+]` → "Add image" → Select an image file.
**Expected:** Source chip appears with image filename. Toast confirms addition.

---

## E. Previous Sources via [+] Menu

**Test 8:** Click `[+]` → "Previous sources" → Dialog shows recent documents and pasted text sources.
**Expected:** List shows ready documents and context sources with checkboxes.

**Test 9:** Select a document from previous sources → Confirm.
**Expected:** Source chip appears. Source ID is sent with next chat request.

---

## F. Source Chips

**Test 10:** Attach a source → verify chip appears above composer with correct icon and name.
**Expected:** 📄 for documents, 📋 for pasted text, 🖼️ for images.

**Test 11:** Click × on a source chip.
**Expected:** Chip is removed. Source is no longer sent with messages.

---

## G. Agent Router

**Test 12:** Attach a source → ask "What is 2 + 2?"
**Expected:** Agent still retrieves because sources are attached (even though question is simple). This is by design — attached sources imply the user wants them considered.

**Test 13:** Remove all sources → ask "What is normalization?"
**Expected:** `agent action=answer_directly`. No retrieval. General knowledge answer.

**Test 14:** Attach a source → ask "According to this document, what is X?"
**Expected:** `agent action=retrieve_context`. Strong source reference detected.

---

## H. Follow-up Questions

**Test 15:** Attach a source → ask a question → then ask "Give me a simple example."
**Expected:** Sources remain attached (still in composer state). Agent can use them for follow-up.

---

## I. Missing Information

**Test 16:** Attach a small document → ask something definitely not in it.
**Expected:** Agent says "I couldn't find enough information about that in the provided materials." Does NOT fabricate source-based answer.

---

## J. Multiple Sources

**Test 17:** Attach 2 documents + 1 pasted text → ask a question.
**Expected:** Agent retrieves from all sources. Answer references multiple sources. Multiple source indicators at end.

---

## K. Security

**Test 18:** Try to send a `sourceIds` array containing another user's document ID.
**Expected:** That source is silently ignored (not loaded). Only the user's own sources are resolved.

**Test 19:** Try to access `GET /api/context-sources` without authentication.
**Expected:** 401 unauthorized.

---

## L. Backward Compatibility

**Test 20:** Send a chat request with only `context.documentId` (no `sourceIds`).
**Expected:** Legacy document grounding path is used. Answer is grounded in the document.

**Test 21:** Send a chat request with `context.sourceIds` including a document ID.
**Expected:** New agent pipeline is used. Document is retrieved via the agent context.

---

## M. Student Mode Compatibility

**Test 22:** Switch to Student mode → attach a source → ask "Teach me question 15 like I'm a beginner."
**Expected:** Agent uses document context + student context. Answer is adapted to learner level.

---

## N. Programming Mode Compatibility

**Test 23:** Switch to General mode → attach a code file → ask "Fix this code."
**Expected:** Programming mode detection fires. Source context is also available. Answer addresses both.

---

## O. Existing Phase 4 Features

**Test 24:** Ask "Remember that I study at MIT."
**Expected:** Memory is extracted and saved. Normal acknowledgement.

**Test 25:** In Student mode, ask about weak topics.
**Expected:** Student context block is injected. Existing intelligence system works.

**Test 26:** Ask about today's study plan.
**Expected:** Planner context block is injected. Existing planner system works.

---

## P. Chat Streaming

**Test 27:** Send a message with sources attached.
**Expected:** Response streams normally. Source chips remain visible during streaming.

---

## Q. Error Handling

**Test 28:** Upload a file → trigger processing failure → ask about it.
**Expected:** Agent says it couldn't find relevant content. Does not crash.

---

## R. Retrieval Confidence

**Test 29:** Attach a document → ask a question that exactly matches content (e.g. a question title from the document).
**Expected:** Console log shows `confidence=high bestScore>=120`. Answer is well-grounded.

**Test 30:** Attach a document → ask a loosely related question.
**Expected:** Console log shows `confidence=medium` or `confidence=low`. Answer still attempts to ground but is appropriately cautious.

---

## S. Lint + Build

**Test 31:** `npm run lint` → 0 errors, 0 warnings.
**Test 32:** `npm run build` → successful, all routes compile.
