import { describe, expect, it } from 'vitest';
import { titleFromText } from './titles';

describe('titleFromText', () => {
  it('takes the first sentence when the text carries terminal punctuation', () => {
    expect(titleFromText('Fix nginx. Then deploy the cert.')).toBe('Fix nginx.');
    expect(titleFromText('Buy milk? also bread')).toBe('Buy milk?');
  });

  it('falls back to the whole trimmed text without terminal punctuation', () => {
    expect(titleFromText('  buy fresh milk soon  ')).toBe('buy fresh milk soon');
    expect(titleFromText('one\nmultiline\nline')).toBe('one\nmultiline\nline');
  });

  it('truncates beyond 60 chars to 57 chars plus an ellipsis (60 exactly stays verbatim)', () => {
    expect(titleFromText('a'.repeat(60))).toBe('a'.repeat(60));
    expect(titleFromText('b'.repeat(61))).toBe('b'.repeat(57) + '…');
  });
});