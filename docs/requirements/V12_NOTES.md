# KLEO acceptance automation v12

- `KLEO-FUN-BOOK-003-AC-02`: public booking cancellation is idempotent; repeated cancellation returns the already-cancelled appointment without creating a second cancellation event.
- `KLEO-FUN-AUTH-001-AC-02`: login accepts an optional selected location and rejects a non-admin user with HTTP 403 when that location differs from the assigned location.
- `/api/logout` clears the HttpOnly authentication cookie and disables response caching; the frontend calls it on both explicit and idle logout.
- `KLEO-GEN-AUTH-001` remains outside the backend-only automation registry until the frontend idle timer evidence and backend cookie invalidation are represented by a single cross-repository evidence record.
