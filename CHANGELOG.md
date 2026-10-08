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
