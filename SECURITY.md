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
  systems Termail restricts its data directories to owner-only access.
  On Windows, POSIX mode bits do not apply and Termail does not set or
  verify ACLs; see
  [Windows local-data permissions](#windows-local-data-permissions) below.
* AI features (`s` summarize, `d` draft reply) send the selected email's
  headers and a bounded portion of its body to the configured OpenRouter
  endpoint only when explicitly invoked. Review `src/core/ai/prompts.ts`
  for the exact payload shape.

## Windows local-data permissions

Termail's default Windows paths are:

- Config: `<home>\.config\termail\config.json`
- Database: `<home>\.local\share\termail\db.sqlite`

`<home>` is `HOME` when it is non-empty; otherwise it is `USERPROFILE`.
These are defaults, and `database.path` can override the database location.

The database contains message headers, body text, and full-text search
copies of that content. SQLite `-wal` and `-shm` sidecars can also contain
sensitive database state.

Termail currently does not set or verify Windows ACLs. Protection relies on
ACLs inherited from the parent directory and is not a Termail-enforced
guarantee. Normal profile ACLs may protect the data from other standard
users, but the actual ACL must be inspected. Administrators, SYSTEM, and
processes running as the same user are outside that confidentiality
boundary. ACLs are not encryption.

Relative or custom database paths, shared folders, network shares, and
filesystems without Windows ACL support may have different exposure. This
does not mean every Windows setup is vulnerable; exposure depends on the
actual ACLs and where the data is stored.

### Read-only ACL inspection

The following PowerShell example only reads ACLs with `icacls`; it uses no
permission-changing options. It checks the default config and database paths
and skips paths that do not exist. If `database.path` overrides the database
location, inspect that path instead.

```powershell
$homeDir = $env:HOME
if (-not $homeDir) { $homeDir = $env:USERPROFILE }
if (-not $homeDir) { throw 'HOME and USERPROFILE are both unset.' }

$configDir = Join-Path $homeDir '.config\termail'
$configFile = Join-Path $configDir 'config.json'
$dbDir = Join-Path $homeDir '.local\share\termail'
$dbFile = Join-Path $dbDir 'db.sqlite'

$paths = @(
  $configDir,
  $configFile,
  $dbDir,
  $dbFile,
  "$dbFile-wal",
  "$dbFile-shm"
)

foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) {
    Write-Host "`n$path"
    icacls $path
  }
}
```

This is an inspection aid, not proof of every effective permission.
`icacls` output can be affected by group membership, inherited ACEs, share
permissions, and other Windows access controls.

Do not recursively rewrite ACLs across user profiles or arbitrary custom
paths as a workaround. Broad ACL changes can break access, backups, or other
applications. See [README.md](README.md#configuration) for configuration
details.

## No bug-bounty program

There is currently no paid bounty. Valid reports are acknowledged in
release notes at the maintainer's discretion.
