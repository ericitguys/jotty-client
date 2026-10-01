import { describe, expect, it } from 'vitest';
import { snippetFromHtml } from './snippet';

describe('snippetFromHtml', () => {
  it('strips tags and decodes entities via DOMParser textContent', () => {
    expect(snippetFromHtml('<p>&nbsp;oat milk &amp; bread</p>')).toBe('oat milk & bread');
  });

  it('collapses markup block boundaries to a single space', () => {
    expect(snippetFromHtml('<h1>t1</h1><p>t2</p>')).toBe('t1 t2');
  });

  it('collapses whitespace runs to single spaces and trims', () => {
    expect(snippetFromHtml('<p>a</p>   <p> b\tc</p>')).toBe('a b c');
  });

  it('caps at max chars without cutting the last word', () => {
    expect(snippetFromHtml('<p>aaaa bbbb cccc</p>', 10)).toBe('aaaa bbbb');
    expect(snippetFromHtml('<p>abcdefghij0123456</p>', 10)).toBe('abcdefghij');
  });

  it('empty and tags-only content yield the empty string (no snippet span rides it)', () => {
    expect(snippetFromHtml('')).toBe('');
    expect(snippetFromHtml('<p></p>')).toBe('');
  });

  it('drops script/style subtrees (R5 probe: code is not note content)', () => {
    expect(snippetFromHtml('<p>x</p><script>var steal = 1</script><p>y</p>')).toBe('x y');
    expect(snippetFromHtml('<style>.m{color:red}</style><p>kept</p>')).toBe('kept');
    expect(snippetFromHtml('<p>outer<script>nested var x = 1</script></p>')).toBe('outer');
  });
});