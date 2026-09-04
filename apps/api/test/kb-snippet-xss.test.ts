import { describe, it, expect } from 'vitest';
import { renderSnippet, SNIPPET_START, SNIPPET_STOP } from '../src/modules/kb.js';

// STORED XSS, found during a design review and confirmed against real Postgres.
//
// The KB search snippet came from ts_headline() and was rendered with
// dangerouslySetInnerHTML in three places — the agent KB page and TWO customer-facing
// portal surfaces, including the virtual agent's answer.
//
// ts_headline drops well-formed tags, which is why this looked safe. It does NOT drop
// everything: an UNCLOSED tag and `<svg/onload=...>` both survive verbatim. Anyone holding
// kb.author could therefore run script in a reader's session — including a platform admin's,
// and including customers in another tenant's portal.
//
// The fix stops trusting ts_headline to sanitize. It marks matches with control characters
// that cannot appear in page text, escapes the entire string, and only then reintroduces the
// two <b> tags it is allowed to emit.
const mark = (s: string) => `${SNIPPET_START}${s}${SNIPPET_STOP}`;

describe('renderSnippet', () => {
  it('neutralizes the payloads that got past ts_headline', () => {
    for (const payload of [
      'Reset your widget <img src=x onerror=alert(1) here',
      'Reset your widget <svg/onload=alert(1)> here',
      'Reset your widget <script>alert(1)</script> here',
    ]) {
      const out = renderSnippet(payload);
      expect(out).not.toMatch(/<img/i);
      expect(out).not.toMatch(/<svg/i);
      expect(out).not.toMatch(/<script/i);
      expect(out).toContain('&lt;');
    }
  });

  it('still emits the highlight the search results depend on', () => {
    expect(renderSnippet(`Reset your ${mark('widget')} here`))
      .toBe('Reset your <b>widget</b> here');
  });

  it('escapes a payload that sits inside the highlight itself', () => {
    const out = renderSnippet(mark('<svg/onload=alert(1)>'));
    expect(out).toBe('<b>&lt;svg/onload=alert(1)&gt;</b>');
  });

  // A quote-based break-out would let an attacker escape an attribute if the snippet is ever
  // interpolated somewhere other than a text node.
  it('escapes quotes and ampersands, not just angle brackets', () => {
    expect(renderSnippet(`a " b & c ' d`)).toBe('a &quot; b &amp; c &#39; d');
  });

  it('passes ordinary text through unchanged', () => {
    expect(renderSnippet('Reset your password from the portal')).toBe('Reset your password from the portal');
  });
});
