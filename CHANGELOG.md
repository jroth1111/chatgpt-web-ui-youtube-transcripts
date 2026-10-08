# 0.4.3

- Reuse the invocation-local authenticated immutable snapshot manifest while
  streaming cached chunks. The incremental cleaner already holds previous
  cues, so following pages need one chunk read instead of three database reads.
- Keep owner/snapshot/video/language checks and reject JSON-shaped capability
  substitutes. No cross-request cache, storage rewrite or migration is added.
- Surface only fixed nonsecret storage-error classes, never provider messages,
  SQL, identities, paths or credential-bearing exception causes.
- Add synthetic query-budget, namespace-isolation and error-redaction tests.
  Query savings do not establish a particular live platform failure cause.

# 0.4.2

- Stop cached cleaned assembly at the exact wire-output bound or time budget,
  returning resumable progress instead of discarding available captions.
- Pack default single-video cleaned continuations across immutable storage
  chunks. Validate snapshot/hash/language/page/index continuity; preserve raw
  and timed paging, explicit paging, fitting full texts and all stored hashes.
- Expose the software version in actual tool replies and include it in whole
  response sizing. No database migration, worker/key change or failure reset.
- Add deadline, Unicode/ASR reconstruction, integrity and wire-size regressions.
  Synthetic checks are not live ChatGPT-client acceptance.

# 0.4.1

- Align package, MCP discovery and runtime verification software versions.
- Retain and verify the existing queue/lease, terminal-denial recovery,
  creator-backlog and modern playlist/continuation repairs from the deployed
  baseline. This release does not delete snapshots, reset failures, change
  acquisition signing keys or require a database migration.
- Apply patched Next.js, React Server Components, Vite and compatible
  Cloudflare tooling dependencies; retain the existing framework contract.
- Remove personal repository-account literals from public templates and add
  personal-email/deployment-host checks while preserving upstream licences.
- A complete result means the complete available caption snapshot, not proof
  that captions cover every spoken word. Oversized replies require every
  returned continuation cursor. Tests/builds are not live MCP-client acceptance.

Some development-only dependency advisories require upstream fixes or a
breaking toolchain change. Never silently downgrade or force-update the
framework or migration tools merely to clear the audit count.
