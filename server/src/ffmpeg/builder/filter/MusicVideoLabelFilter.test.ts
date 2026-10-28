import { describe, expect, it } from 'vitest';
import { escapeDrawtextValue } from './MusicVideoLabelFilter.ts';

describe('escapeDrawtextValue', () => {
  it.each([
    ["I Ain't Mad At Cha", "I Ain\\\\\\'t Mad At Cha"],
    ["Sinéad O'Connor", "Sinéad O\\\\\\'Connor"],
    ['100%', '100%'],
    ['Artist: Name', 'Artist\\\\: Name'],
    ['Hey Ya!', 'Hey Ya!'],
    ['a,b;[c]', 'a\\,b\\;\\[c\\]'],
    ['a\\b', 'a\\\\\\\\b'],
  ])('escapes %s', (text, expected) => {
    expect(escapeDrawtextValue(text)).toBe(expected);
  });
});
