/**
 * Terminal escape-injection sanitization for text rendered with OpenTUI.
 *
 * OpenTUI's `TextRenderable` passes string content through to the
 * terminal byte stream verbatim (no ANSI/OSC filtering), so any ESC,
 * BEL, or C1 byte in remote email content becomes a live terminal
 * control sequence (window title, screen clear, hyperlinks, ...).
 * Termail therefore strips terminal control characters at the UI
 * boundary, just before untrusted strings are assigned to renderables.
 *
 * Removed: C0 controls U+0000-U+001F except newline (U+000A) and tab
 * (U+0009), DEL (U+007F), and C1 controls (U+0080-U+009F). This takes out
 * ESC (introducer of every CSI/OSC/APC/DCS sequence), BEL (a sequence
 * terminator), and the 8-bit C1 introducers, while preserving newlines,
 * tabs, and all ordinary Unicode text including multiline email bodies.
 *
 * The ranges are expressed as code-point numbers (never as escape
 * sequences or literal control bytes) so the pattern stays visible and
 * auditable in source form.
 *
 * This only transforms the string being rendered. Stored email content,
 * search indexes, and AI prompts are never modified through this helper.
 */
function isTerminalControlCode(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    (code >= 0x0b && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f)
  );
}

export function sanitizeForTerminal(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (!isTerminalControlCode(code)) {
      out += ch;
    }
  }
  return out;
}
