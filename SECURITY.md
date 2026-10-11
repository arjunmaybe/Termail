# Security Policy

## Supported versions

Only the latest `main` commit is supported with security fixes. There are
no maintained release branches.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's
**Security** tab, then **Report a vulnerability**. Describe the issue,
its impact, and reproduction steps. Do not include live credentials,
mailbox contents, or other secrets in the report; redacted proof-of-concept
material is sufficient.

Before reporting, confirm that private vulnerability reporting is enabled
for the repository (Settings → Code security → Private vulnerability
reporting). If it is unavailable, open a public issue that describes the
issue class without exploit details and request a private channel.

## Scope notes

* Email credentials are resolved from `TERMAIL_<ACCOUNT>_PASSWORD` /
  `TERMAIL_<ACCOUNT>_OAUTH_TOKEN` environment variables or the Windows
  Credential Manager entry created by the documented one-time setup flow.
  They must never appear in config files, the SQLite database, logs, or
  issue reports.
* The local SQLite mail database is **not encrypted by Termail**. On POSIX
  systems Termail restricts its data directories to owner-only access;
  on Windows, POSIX mode bits do not apply and no ACL hardening is
  performed — configure filesystem ACLs outside Termail if needed.
* AI features (`s` summarize, `d` draft reply) send the selected email's
  headers and a bounded portion of its body to the configured OpenRouter
  endpoint only when explicitly invoked. Review `src/core/ai/prompts.ts`
  for the exact payload shape.

## No bug-bounty program

There is currently no paid bounty. Valid reports are acknowledged in
release notes at the maintainer's discretion.
