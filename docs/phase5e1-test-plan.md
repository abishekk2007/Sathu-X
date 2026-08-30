# Phase 5E-1 — Test Plan

## Test Categories

### A — PNG Upload
1. Open Chat → [+] → Add image → Select a .png file
2. Verify: toast shows "uploaded as context"
3. Verify: source chip appears in chat composer
4. Verify: context_sources record exists with storage_path, mime_type, image_width, image_height

### B — JPEG Upload
1. Open Chat → [+] → Add image → Select a .jpg file
2. Verify: same flow as PNG
3. Verify: mime_type = "image/jpeg"

### C — WEBP Upload
1. Open Chat → [+] → Add image → Select a .webp file
2. Verify: same flow as PNG
3. Verify: mime_type = "image/webp"

### D — Image Metadata
1. Upload any supported image
2. Query context_sources table: verify width, height, file_size_bytes, content_hash are populated
3. Verify: storage_path follows pattern `{user_id}/images/{source_id}/{filename}`

### E — Image Processing States
1. Upload image via Chat
2. Verify: processing_status = "ready" immediately after upload
3. Verify: processing_error is NULL

### F — Duplicate Processing Prevention
1. Upload same image twice (same filename + content)
2. Verify: two separate context_sources records (different IDs)
3. Verify: both have same content_hash
4. Verify: both stored in different storage paths (different source_ids)

### G — Retry After Failure
1. Simulate: manually set a context_source processing_status to "failed" via Supabase Dashboard
2. Attempt to use that source in chat
3. Verify: source is included with processingError metadata
4. Verify: chat responds gracefully about processing failure

### H — Corrupted Image
1. Rename a .txt file to .png
2. Attempt upload via Chat → Add image
3. Verify: server validates magic bytes and rejects with "Unsupported image format"

### I — Oversized Image
1. Create or find an image > 25 MB
2. Attempt upload via Chat → Add image
3. Verify: rejection with "exceeds the 25 MB limit"

### J — Private Storage
1. Upload image as User A
2. Note the storage_path
3. Attempt to access the storage file as User B (via different auth session)
4. Verify: access denied (RLS blocks cross-user access)

### K — User Isolation
1. Upload image as User A
2. Query context_sources as User B with User A's source ID
3. Verify: returns empty (RLS blocks cross-user query)

### L — Scanned PDF
1. Upload a scanned/image-only PDF as a document (via Upload file)
2. Verify: existing text extraction + OCR fallback works
3. Verify: document processes successfully with text content
4. Note: visual_assets for PDF pages are NOT generated in 5E-1 (deferred to 5E-2)

### M — Text PDF
1. Upload a normal text PDF
2. Verify: existing text extraction works unchanged
3. Verify: document_chunks are created correctly

### N — PDF Page Rendering
1. Note: PDF page rendering to images is available via @napi-rs/canvas but NOT automatically triggered in 5E-1
2. 5E-2 will add automatic page rendering for scanned PDFs
3. Verify: the @napi-rs/canvas dependency is installed and functional

### O — PPTX Visual Processing
1. Note: PPTX visual slide rendering is deferred to 5E-2
2. Verify: existing PPTX text extraction still works

### P — Previous Image Sources
1. Upload an image via Chat → [+] → Add image
2. Close chat, reopen
3. Click [+] → Previous sources
4. Verify: image source appears in the list
5. Select it → verify: source chip appears

### Q — Image Preview
1. Upload image via Chat → Add image
2. Verify: source chip shows image icon (🖼) and filename
3. Verify: chip shows remove button

### R — Source Removal
1. Attach image source to chat
2. Click remove on the source chip
3. Verify: source removed from composer
4. Verify: context_sources record still exists (not deleted, just detached)

### S — Processing Status
1. Upload image
2. Verify: API response includes processingStatus: "ready"
3. Verify: GET /api/context-sources returns the image with processingStatus

### T — Processing Error
1. Attempt to upload a 0-byte file renamed as .png
2. Verify: server returns validation error
3. Verify: no context_source record created for invalid files

### U — Content Hash
1. Upload same image content with different filenames
2. Query: verify both have same content_hash
3. Verify: both are stored separately (different source IDs)

### V — Existing RAG Regression
1. Normal chat without sources → verify works
2. Text document Q&A → verify works
3. Pasted text context → verify works
4. Multi-source retrieval → verify works
5. Source comparison → verify works
6. Previous sources → verify works
7. Streaming → verify works

### W — DELETE with Storage Cleanup
1. Upload image via Chat → Add image
2. Note storage_path
3. Delete the source via Previous Sources → remove
4. Verify: context_sources record deleted
5. Verify: storage file at storage_path is also deleted

### X — Dimensions Validation
1. Attempt to upload an image with dimensions > 10000px
2. Verify: rejected with dimensions error
3. Upload normal-sized image (e.g., 800x600)
4. Verify: accepted and dimensions recorded

### Y — Multiple Image Types in Sequence
1. Upload PNG → verify success
2. Upload JPEG → verify success
3. Upload WEBP → verify success
4. Verify: all three appear in context_sources with correct mime types

### Z — Graceful Error Messages
1. Upload unsupported file type → verify user-friendly error
2. Upload oversized image → verify user-friendly error
3. Upload corrupted image → verify user-friendly error
4. Network error during upload → verify "Network error" message
