import { describe, it, expect } from 'vitest'
import { generateDiff } from './diff.js'

// Strip ANSI codes for easier assertion
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

describe('generateDiff', () => {
  describe('no changes', () => {
    it('returns no changes message for identical text', () => {
      const result = generateDiff('hello world', 'hello world')
      expect(result.hasChanges).toBe(false)
      expect(result.formatted).toBe('(no changes)')
    })
  })

  describe('single-line inline diff', () => {
    it('shows addition at end of line', () => {
      const result = generateDiff(
        "Here's a test 2026-01-31 15:47",
        "Here's a test 2026-01-31 15:47 (ANSI test)",
      )
      expect(result.hasChanges).toBe(true)
      const stripped = stripAnsi(result.formatted)
      // For pure additions, only shows + line with highlight on added part
      expect(stripped).toContain("+ Here's a test 2026-01-31 15:47 (ANSI test)")
    })

    it('shows replacement changes', () => {
      const result = generateDiff('hello world', 'hello universe')
      expect(result.hasChanges).toBe(true)
      const stripped = stripAnsi(result.formatted)
      expect(stripped).toContain('- hello world')
      expect(stripped).toContain('+ hello universe')
    })

    it('handles complete replacement', () => {
      const result = generateDiff('foo', 'bar')
      expect(result.hasChanges).toBe(true)
      const stripped = stripAnsi(result.formatted)
      expect(stripped).toContain('- foo')
      expect(stripped).toContain('+ bar')
    })

    it('shows two lines for single-line changes', () => {
      const result = generateDiff('old text', 'new text')
      const lines = result.formatted.split('\n')
      expect(lines.length).toBe(2)
    })
  })

  describe('multi-line diff', () => {
    it('shows added lines', () => {
      const result = generateDiff('line 1\nline 2', 'line 1\nline 2\nline 3')
      expect(result.hasChanges).toBe(true)
      expect(stripAnsi(result.formatted)).toContain('+ line 3')
    })

    it('shows removed lines', () => {
      const result = generateDiff('line 1\nline 2\nline 3', 'line 1\nline 3')
      expect(result.hasChanges).toBe(true)
      expect(stripAnsi(result.formatted)).toContain('- line 2')
    })

    it('shows changed lines', () => {
      const result = generateDiff('line 1\nold line\nline 3', 'line 1\nnew line\nline 3')
      expect(result.hasChanges).toBe(true)
      expect(stripAnsi(result.formatted)).toContain('- old line')
      expect(stripAnsi(result.formatted)).toContain('+ new line')
    })
  })

  describe('ANSI formatting', () => {
    it('includes ANSI codes for removed content', () => {
      const result = generateDiff('old text', 'new text')
      // Check for red color codes (167 fg, 52 bg)
      expect(result.formatted).toContain('\x1b[38;5;167m')
      expect(result.formatted).toContain('\x1b[48;5;52m')
    })

    it('includes ANSI codes for added content', () => {
      const result = generateDiff('old text', 'new text')
      // Check for green color codes (77 fg, 22 bg)
      expect(result.formatted).toContain('\x1b[38;5;77m')
      expect(result.formatted).toContain('\x1b[48;5;22m')
    })

    it('resets colors after formatting', () => {
      const result = generateDiff('old', 'new')
      // Check for reset codes
      expect(result.formatted).toContain('\x1b[39m') // reset fg
      expect(result.formatted).toContain('\x1b[49m') // reset bg
    })
  })
})
