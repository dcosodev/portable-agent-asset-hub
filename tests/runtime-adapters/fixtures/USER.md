# USER.md (test fixture)

This is a fixture for the runtime-adapters tests. The body
content must NOT contain any reference to local roots or secrets.
The apply pipeline re-reads this exact file byte-for-byte; the
preview pipeline summarises it by sha256+size only.
