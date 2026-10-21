// The "Locked out? Reset your password" link on the public login page. It must point at the
// right cloud's portal — a GCC High account cannot reset on the commercial page — and nothing
// but an https URL may ever reach that href.
import { describe, it, expect } from 'vitest';
import { parseSsprUrl } from '../src/config.js';

describe('parseSsprUrl', () => {
  it('defaults to the US Government portal in the gov enclave', () => {
    expect(parseSsprUrl({}, 'gov')).toBe('https://passwordreset.microsoftonline.us');
  });

  it('defaults to the commercial portal otherwise', () => {
    expect(parseSsprUrl({}, 'commercial')).toBe('https://passwordreset.microsoftonline.com');
  });

  it('treats an empty SSPR_URL (as .env.example ships it) as unset', () => {
    expect(parseSsprUrl({ SSPR_URL: '  ' }, 'gov')).toBe('https://passwordreset.microsoftonline.us');
  });

  it('honours an https override', () => {
    expect(parseSsprUrl({ SSPR_URL: 'https://aka.ms/sspr' }, 'gov')).toBe('https://aka.ms/sspr');
  });

  it('refuses anything that is not an absolute https URL', () => {
    for (const bad of ['http://passwordreset.microsoftonline.us', 'javascript:alert(1)', 'passwordreset.microsoftonline.us', 'not a url']) {
      expect(parseSsprUrl({ SSPR_URL: bad }, 'gov')).toBe('https://passwordreset.microsoftonline.us');
    }
  });
});
