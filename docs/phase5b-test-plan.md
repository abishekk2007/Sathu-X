# Phase 5B — Manual Test Plan

## Document Extraction & Grounded Q&A

### A. PDF Upload & Processing
1. Navigate to /documents
2. Upload a PDF file (e.g., "DBMS Question Bank.pdf")
3. Verify upload succeeds (toast: "Document uploaded.")
4. Open document details
5. Click "Process Document"
6. Verify processing completes (processing_status = ready)
7. Verify extracted text length is shown
8. Verify processed date is shown

### B. DOCX Upload & Processing
1. Upload a .docx file
2. Process it
3. Verify text is extracted correctly
4. Verify status = ready

### C. TXT Upload & Processing
1. Upload a .txt file
2. Process it
3. Verify text is extracted
4. Verify status = ready

### D. Markdown Upload & Processing
1. Upload a .md file
2. Process it
3. Verify text is extracted
4. Verify status = ready

### E. Processing Failure
1. Upload a corrupted PDF (or 0-byte file if possible)
2. Click "Process Document"
3. Verify processing_status = failed
4. Verify error message is displayed
5. Verify "Retry Processing" button appears

### F. Retry Processing
1. After a failed processing, click "Retry Processing"
2. Verify processing attempts again
3. If the document is actually valid, verify it succeeds

### G. Document Selection in Chat
1. Navigate to /chat
2. Verify the document selector dropdown appears
3. Verify only READY documents are selectable
4. Select a READY document
5. Verify the document name chip appears (📄 filename)
6. Verify the X button clears the document selection

### H. Question Answered from Document
1. Select a processed document (e.g., "DBMS Question Bank.pdf")
2. Ask: "What is normalization?"
3. Verify the answer is grounded in the document content
4. Verify a source indicator appears (📄 Source: DBMS Question Bank.pdf)

### I. Question Not Found in Document
1. Select a document about DBMS
2. Ask: "What is the capital of France?"
3. Verify the response indicates the information was not found in the selected document
4. Verify it does NOT silently answer from general knowledge without disclosure

### J. Question Bank Pattern Matching
1. Select a question bank document
2. Ask: "What is the answer for question 15?"
3. Verify the retrieval attempts to find question 15
4. If found, verify the answer references the question

### K. Document Context Bounded
1. Select a large document
2. Ask a question
3. Verify the context sent to Gemini is bounded (not the entire document)
4. Verify the answer still makes sense

### L. Normal Chat Without Document
1. Remove any document selection
2. Ask a normal question
3. Verify normal Spidey Chat behavior (no document grounding)

### M. Student Mode Compatibility
1. Select a document
2. Switch to Student mode
3. Ask a question about the document
4. Verify the answer is grounded in the document
5. Verify Student mode personality is preserved

### N. Subject/Topic + Document Context
1. Select a subject, topic, AND a document
2. Ask a question
3. Verify all three context types are sent
4. Verify the answer reflects the document content

### O. Document Deletion
1. Delete a document from /documents
2. Verify it no longer appears in the Chat document selector
3. Verify deleting a document cascades to its chunks

### P. User Isolation
1. Log in as User A, upload and process a document
2. Log in as User B
3. Verify User A's document does NOT appear in User B's document selector
4. Manually attempt to use User A's documentId in a Chat request
5. Verify a safe 404/not_found is returned

### Q. Unauthorized Document ID
1. Send a Chat request with a random UUID as documentId
2. Verify a safe error response (no information leak)

### R. Existing Phase 4 Functionality
1. Verify Phase 4A memory still works (ask Spidey to remember something)
2. Verify Phase 4B student intelligence still works (subjects, topics)
3. Verify Phase 4C study planner still works
4. Verify Phase 4D productivity tracking still works

### S. Programming Mode
1. Switch to General mode
2. Ask a programming question
3. Verify code assistance still works normally
4. Select a document and ask a programming question
5. Verify the answer is grounded in the document

### T. Multiple Documents
1. Upload and process 2+ documents
2. Select one document at a time
3. Verify only the selected document's content is used
4. Verify switching documents works correctly

### U. Large Document Handling
1. Upload a large PDF (10+ pages)
2. Process it
3. Verify chunking completes
4. Verify retrieval returns relevant passages
5. Verify the bounded context works within Gemini limits

### V. Processing Status Display
1. Upload a document (status: uploaded, processing: pending)
2. Verify the detail dialog shows correct status
3. Process it (status: processing, then: ready)
4. Verify the detail dialog updates to show ready
5. Verify extracted text length is displayed
