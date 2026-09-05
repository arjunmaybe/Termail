/**
 * IMAP folder synchronization.
 *
 * Turns the raw mailbox list returned by `ImapService.listMailboxes()` into
 * a deterministic, deduplicated, classified set of folders suitable for
 * later persistence or display.
 *
 * The functions in this module are pure: no I/O, no IMAP calls. Tests
 * exercise them directly without standing up the full service.
 *
 * Phase 2.2 scope:
 *   - Classify special-use folders (Inbox / Sent / Drafts / Trash /
 *     Archive / Junk / Spam) from server-provided flags.
 *   - Fall back to conservative name-based detection when the server
 *     doesn't advertise a special-use flag.
 *   - Preserve custom / unknown folders unchanged.
 *   - Resolve nested folder relationships using the server-supplied
 *     delimiter (never hardcoded).
 *   - Deduplicate mailbox aliases (e.g. "INBOX" vs "Inbox", "Sent" vs
 *     "Sent Items") and produce deterministic ordering.
 *
 * Not in scope:
 *   - Reading or syncing message counts / unread counts.
 *   - Selecting a mailbox or issuing IMAP commands.
 *   - Database persistence.
 */

import type { FolderType } from '../types/account.js';

/**
 * Normalized folder record produced by `syncMailboxes`. Intentionally a
 * plain shape (not the DB `Folder` type) so this module has no opinion
 * about persistence. The next milestone maps `SyncFolder[]` to database
 * rows.
 */
export interface SyncFolder {
  /** Server path as reported by the IMAP server, preserved verbatim. */
  path: string;
  /** Human-readable display name, derived from the last path segment. */
  displayName: string;
  /** Server-supplied hierarchy delimiter, e.g. "/" or ".". */
  delimiter: string;
  /** IMAP mailbox flags as a flat string array, e.g. ["\\Inbox", "\\HasChildren"]. */
  flags: string[];
  /**
   * Special-use attribute if the server reported one, without the leading
   * backslash and lower-cased, e.g. "inbox", "sent". Empty string when the
   * server did not report one.
   */
  specialUse: string;
  /** Classified folder role, one of `FolderType` from `core/types/account`. */
  type: FolderType;
  /**
   * Whether the mailbox can be selected (opened). Servers advertise
   * `\Noselect` for intermediate hierarchy nodes that exist only to
   * contain children. We default to `true` when the flag is missing.
   */
  selectable: boolean;
  /** Path of the parent mailbox, or `null` for top-level entries. */
  parentPath: string | null;
  /** Nesting depth, 0 for top-level. */
  depth: number;
}

/** What `syncMailboxes` returns alongside the normalized folder list. */
export interface FolderSyncResult {
  /** Deterministic, deduped folder list. */
  folders: SyncFolder[];
  /** Total raw entries before dedup. */
  total: number;
  /** Number of raw entries dropped as duplicates / aliases. */
  skipped: number;
}

/** Lower-cased set of folder types we treat as a special-use role. */
const SPECIAL_USE_TYPES: ReadonlySet<FolderType> = new Set<FolderType>([
  'inbox',
  'sent',
  'drafts',
  'trash',
  'archive',
  'spam',
]);

/** Fixed display order for the special-use categories. */
const TYPE_ORDER: Readonly<Record<FolderType, number>> = {
  inbox: 0,
  sent: 1,
  drafts: 2,
  archive: 3,
  spam: 4,
  trash: 5,
  starred: 6,
  important: 7,
  custom: 8,
};

/**
 * Conservative name-based fallback for servers that don't advertise
 * special-use flags. Keys are lower-cased, trimmed folder display names;
 * values are the `FolderType` they map to.
 */
const NAME_FALLBACK: ReadonlyMap<string, FolderType> = new Map<string, FolderType>([
  ['inbox', 'inbox'],
  ['sent', 'sent'],
  ['sent items', 'sent'],
  ['sent messages', 'sent'],
  ['sent mail', 'sent'],
  ['drafts', 'drafts'],
  ['draft', 'drafts'],
  ['trash', 'trash'],
  ['deleted', 'trash'],
  ['deleted items', 'trash'],
  ['bin', 'trash'],
  ['archive', 'archive'],
  ['archives', 'archive'],
  ['all mail', 'archive'],
  ['junk', 'spam'],
  ['junk mail', 'spam'],
  ['junk e-mail', 'spam'],
  ['bulk mail', 'spam'],
  ['spam', 'spam'],
]);

/**
 * Map a single raw mailbox entry to a `SyncFolder`. Exposed (rather than
 * only used internally) so tests can call it directly with one fixture at
 * a time.
 */
export function normalizeMailboxEntry(entry: {
  path: string;
  delimiter: string;
  flags?: ReadonlyArray<string> | Set<string>;
  specialUse?: string;
}): SyncFolder {
  const flags = toFlagArray(entry.flags);
  const specialUse = normalizeSpecialUse(entry.specialUse);
  const type = classifyType({
    path: entry.path,
    displayName: lastSegment(entry.path, entry.delimiter),
    flags,
    specialUse,
  });
  const selectable = !flags.some((f) => f.toLowerCase() === '\\noselect');
  const { parentPath, depth } = splitPath(entry.path, entry.delimiter);
  return {
    path: entry.path,
    displayName: lastSegment(entry.path, entry.delimiter),
    delimiter: entry.delimiter,
    flags,
    specialUse,
    type,
    selectable,
    parentPath,
    depth,
  };
}

/**
 * Turn an array of raw mailbox entries into a `FolderSyncResult`. Handles
 * deduplication, classification, and ordering. Pure function.
 */
export function syncMailboxes(
  rawEntries: ReadonlyArray<{
    path: string;
    delimiter: string;
    flags?: ReadonlyArray<string> | Set<string>;
    specialUse?: string;
  }>
): FolderSyncResult {
  const total = rawEntries.length;
  const seen = new Set<string>();
  const folders: SyncFolder[] = [];

  for (const entry of rawEntries) {
    const normalized = normalizeMailboxEntry(entry);
    const key = dedupeKey(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    folders.push(normalized);
  }

  const ordered = orderFolders(folders);

  return { folders: ordered, total, skipped: total - ordered.length };
}

/**
 * Pick a `FolderType` for a folder using, in order: explicit
 * `specialUse`, an inbox/case-insensitive special flag inside `flags`,
 * and finally a name-based fallback. Custom paths end up as `custom`.
 */
export function classifyType(input: {
  path: string;
  displayName: string;
  flags: ReadonlyArray<string>;
  specialUse: string;
}): FolderType {
  const fromSpecial = specialUseToType(input.specialUse);
  if (fromSpecial) return fromSpecial;

  const fromFlag = flagToType(input.flags);
  if (fromFlag) return fromFlag;

  // INBOX is special: it has to be detected even without special-use
  // metadata, because most servers still advertise it as the literal
  // string "INBOX" (case-insensitive) at the top level.
  if (input.path.toUpperCase() === 'INBOX') return 'inbox';

  const fromName = NAME_FALLBACK.get(input.displayName.toLowerCase().trim());
  if (fromName) return fromName;

  return 'custom';
}

/**
 * Order folders as a depth-first pre-order traversal of the mailbox
 * tree. The traversal starts with INBOX, then visits each top-level
 * folder in a fixed order: special-use types first (Sent, Drafts,
 * Archive, Spam, Trash), then custom folders alphabetically. Children
 * are visited immediately after their parent.
 */
export function orderFolders(folders: ReadonlyArray<SyncFolder>): SyncFolder[] {
  const byParent = new Map<string | null, SyncFolder[]>();
  for (const folder of folders) {
    const list = byParent.get(folder.parentPath) ?? [];
    list.push(folder);
    byParent.set(folder.parentPath, list);
  }
  for (const list of byParent.values()) {
    list.sort(compareFolders);
  }

  const out: SyncFolder[] = [];
  const visit = (parentPath: string | null): void => {
    const list = byParent.get(parentPath) ?? [];
    for (const child of list) {
      out.push(child);
      visit(child.path);
    }
  };
  visit(null);
  return out;
}

/**
 * Compare two folders for ordering. INBOX always comes first. Otherwise:
 *   1. Special-use type order (Sent < Drafts < Archive < Spam < Trash).
 *   2. Lower-cased path alphabetical.
 *
 * `compareFolders` is exposed for tests; `orderFolders` is the higher
 * level entry point that uses it to do the tree walk.
 */
export function compareFolders(a: SyncFolder, b: SyncFolder): number {
  if (a.type === 'inbox' && b.type !== 'inbox') return -1;
  if (b.type === 'inbox' && a.type !== 'inbox') return 1;
  const aOrder = TYPE_ORDER[a.type];
  const bOrder = TYPE_ORDER[b.type];
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
}

// --- internals (exported via `__testing` for unit tests) ---

export const __testing = {
  dedupeKey,
  flagToType,
  normalizeSpecialUse,
  splitPath,
  toFlagArray,
  lastSegment,
  specialUseToType,
};

/** Coerce an optional flag set or array into a string[]. */
function toFlagArray(flags?: ReadonlyArray<string> | Set<string>): string[] {
  if (!flags) return [];
  if (Array.isArray(flags)) return [...flags];
  return Array.from(flags);
}

/** Strip leading backslash and lower-case a special-use attribute. */
function normalizeSpecialUse(specialUse: string | undefined): string {
  if (typeof specialUse !== 'string' || specialUse.length === 0) return '';
  return specialUse.replace(/^\\+/, '').toLowerCase();
}

/** Map a lower-cased special-use string to a `FolderType`, if any. */
function specialUseToType(value: string): FolderType | null {
  if (!value) return null;
  switch (value) {
    case 'inbox':
      return 'inbox';
    case 'sent':
      return 'sent';
    case 'drafts':
      return 'drafts';
    case 'trash':
      return 'trash';
    case 'archive':
      return 'archive';
    case 'junk':
    case 'spam':
      return 'spam';
    default:
      return null;
  }
}

/**
 * Look for an inbox/case-insensitive special flag inside the flag list.
 * Returns the type only when one of the recognized special-use flags is
 * present. INBOX has a non-standard `\Inbox` flag on many servers in
 * addition to the standard `\Inbox` mailbox.
 */
function flagToType(flags: ReadonlyArray<string>): FolderType | null {
  for (const raw of flags) {
    const f = raw.replace(/^\\+/, '').toLowerCase();
    switch (f) {
      case 'inbox':
        return 'inbox';
      case 'sent':
        return 'sent';
      case 'drafts':
        return 'drafts';
      case 'trash':
        return 'trash';
      case 'archive':
        return 'archive';
      case 'junk':
        return 'spam';
      case 'spam':
        return 'spam';
      default:
        break;
    }
  }
  return null;
}

/**
 * Compute the dedup key for a normalized folder. Folders that classify
 * as the same special-use type collapse to a single key (so `INBOX` and
 * `Inbox` both map to `special:inbox`). Custom folders dedupe on
 * lower-cased path.
 */
function dedupeKey(folder: SyncFolder): string {
  if (SPECIAL_USE_TYPES.has(folder.type)) {
    return `special:${folder.type}`;
  }
  return `path:${folder.path.toLowerCase()}`;
}

/** Split a mailbox path on the server-supplied delimiter. */
function splitPath(path: string, delimiter: string): { parentPath: string | null; depth: number } {
  if (!delimiter) {
    return { parentPath: null, depth: 0 };
  }
  const parts = path.split(delimiter).filter((s) => s.length > 0);
  if (parts.length <= 1) {
    return { parentPath: null, depth: 0 };
  }
  const parent = parts.slice(0, -1).join(delimiter);
  return { parentPath: parent, depth: parts.length - 1 };
}

/** Last non-empty segment of a path under the given delimiter. */
function lastSegment(path: string, delimiter: string): string {
  if (!delimiter) return path;
  const parts = path.split(delimiter).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? path;
}
