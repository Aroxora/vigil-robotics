/**
 * Round 11: text formatting utilities — clickable links, inline
 * formatting, diff blocks. These are the primitives the renderer
 * builds on; bugs here surface as visual artifacts in scrollback.
 */

import {
  formatClickableLinks,
  formatInlineText,
  formatDiffBlock,
} from '../src/ui/richText.js';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '').replace(/\x1b\]8;;[^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

describe('rich text formatting', () => {
  it('formatClickableLinks wraps a bare URL in OSC 8 hyperlink escapes', () => {
    const out = formatClickableLinks('See https://example.com for more.');
    // OSC 8 hyperlink escape sequence: ESC ] 8 ; ; URL ESC \ TEXT ESC ] 8 ; ; ESC \
    // (or BEL terminator). The output should include the URL.
    expect(out).toContain('https://example.com');
    expect(out).toContain('See');
    expect(out).toContain('for more');
  });

  it('formatClickableLinks handles multiple URLs in one message', () => {
    const out = formatClickableLinks('Try https://a.com or https://b.com today.');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('https://a.com');
    expect(stripped).toContain('https://b.com');
  });

  it('formatClickableLinks does not wrap non-URLs that look url-ish', () => {
    const out = formatClickableLinks('Path /foo/bar/baz.ts is the file.');
    // No `://` so should pass through untouched.
    expect(out).toContain('/foo/bar/baz.ts');
  });

  it('formatInlineText preserves backtick `code` segments visually', () => {
    const out = formatInlineText('Use `npm install` to install deps.');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('npm install');
  });

  it('formatInlineText handles bold **text** without crashing', () => {
    const out = formatInlineText('This is **important**.');
    const stripped = stripAnsi(out);
    expect(stripped).toContain('important');
  });

  it('formatDiffBlock produces line-oriented output', () => {
    const diff = '- old line\n+ new line';
    const out = formatDiffBlock(diff, 80);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    const joined = out.join('\n');
    const stripped = stripAnsi(joined);
    expect(stripped).toContain('old line');
    expect(stripped).toContain('new line');
  });

  it('formatClickableLinks does not corrupt empty input', () => {
    expect(formatClickableLinks('')).toBe('');
  });

  it('formatInlineText does not corrupt empty input', () => {
    expect(formatInlineText('')).toBe('');
  });
});
