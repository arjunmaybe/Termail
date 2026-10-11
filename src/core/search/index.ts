/**
 * Search module barrel.
 *
 * Phase 3.2 introduces this module. The parser is the only public
 * surface here for now. Execution (Phase 3.3+) will live elsewhere
 * — likely `src/app/services/` — and will consume
 * `parseSearchQuery` results to talk to `SearchRepository`.
 *
 * Consumers should import from here rather than from the individual
 * files so we can refactor internals without breaking downstream
 * code.
 */

export type {
  ParsedSearchQuery,
  ParseIssue,
  ParseIssueKind,
  ParseResult,
} from './SearchQueryParser.js';
export {
  isValidIsoDate,
  parseSearchQuery,
  parseSearchQueryOrEmpty,
  tokenize,
} from './SearchQueryParser.js';
