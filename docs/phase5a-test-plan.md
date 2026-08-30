# Phase 5A — Manual Test Plan

## Prerequisites
- Migration `20260825030000_phase5a_documents.sql` applied via Supabase Dashboard SQL Editor
- Verification SQL `verification-phase5a.sql` passes all 15 checks
- Logged in as a test user

## A. Upload PDF
1. Navigate to `/documents`
2. Click "Upload document" or the dropzone
3. Select a `.pdf` file (< 25 MB)
4. Verify: upload completes, document appears in the list
5. Verify: status shows "Uploaded", processing shows "Pending"
6. Verify: file type shows "PDF"

## B. Upload TXT
1. Upload a `.txt` file
2. Verify: appears in the list with type "TXT"

## C. Upload DOCX
1. Upload a `.docx` file
2. Verify: appears in the list with type "DOCX"

## D. Upload unsupported file
1. Try uploading a `.exe`, `.mp4`, or `.zip` file
2. Verify: client-side rejection with error message "Unsupported file type"

## E. Oversized file
1. Try uploading a file > 25 MB (or set `MAX_DOCUMENT_SIZE_MB=1` in `.env.local` and try a 2 MB file)
2. Verify: client-side rejection with error "File exceeds the 25 MB limit"

## F. Rename document
1. Click the three-dot menu on a document card
2. Click "View details"
3. Click the "Edit" tab
4. Change the name
5. Click "Save changes"
6. Verify: name updates in the list

## G. Delete document
1. Click the three-dot menu on a document card
2. Click "Delete"
3. Confirm the deletion
4. Verify: document is removed from the list
5. Verify: the storage object is also removed (check Supabase Storage dashboard)

## H. Search document
1. Type a document name in the search box
2. Verify: filtered results match the search query
3. Clear the search — verify all documents reappear
4. Search for a non-existent term — verify "No documents match your search."

## I. Filter by subject
1. Create a subject "DBMS" in Student view
2. Upload a document and assign it to "DBMS" subject
3. In Documents, select "DBMS" from the subject filter dropdown
4. Verify: only DBMS-assigned documents appear

## J. Filter by topic
1. Create a topic "Normalization" under DBMS
2. Edit a document's topic to "Normalization"
3. Verify: filter works correctly

## K. Refresh persistence
1. Upload a document
2. Refresh the page (F5)
3. Verify: the document still appears with correct metadata

## L. Storage object exists
1. After uploading, check Supabase Dashboard → Storage → documents bucket
2. Verify: the file exists at `{user_id}/{document_id}/{filename}`
3. Verify: bucket is marked as private

## M. Database metadata exists
1. In Supabase SQL Editor, run: `SELECT * FROM public.documents;`
2. Verify: all fields are populated correctly

## N. Private storage access
1. Try accessing the storage file URL directly in a new incognito window
2. Verify: returns 403/401 (not public)

## O. User isolation
1. Log in as User A, upload a document
2. Log in as User B
3. Verify: User B cannot see User A's documents in the list
4. Verify: User B cannot access User A's document via direct URL

## P. Unauthenticated API
1. In a new incognito window (not logged in), visit `/api/documents`
2. Verify: returns 401

## Q. Invalid subject ID
1. Upload a document with a fake/invalid subjectId
2. Verify: server returns 404 "subject_not_found"

## R. Invalid topic ID
1. Upload a document with a fake/invalid topicId
2. Verify: server returns 404 "topic_not_found"

## S. Empty state
1. Delete all documents (or use a fresh account)
2. Verify: "No documents yet." message appears
3. Verify: supporting text "Upload your study materials to use them with Spidey later."
4. Verify: Upload button is present

## T. Error + Retry
1. Disconnect network, then try loading documents
2. Verify: error state appears with "Try again" button
3. Reconnect network, click "Try again"
4. Verify: documents load successfully

## U. Subject/Topic association
1. Upload a document
2. Click three-dot menu → "Subject & topic"
3. Select a subject and topic
4. Save
5. Verify: document card shows the subject/topic names
6. Verify: can clear the association (set to "No subject")

## V. Drag & drop upload
1. Drag a file onto the dropzone area
2. Verify: visual feedback on drag over
3. Verify: file uploads on drop
