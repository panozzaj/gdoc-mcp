import { describe, it, expect } from 'vitest'
import { parseMarkdown, hasMarkdownFormatting, buildFormattingRequests } from './markdown.js'

describe('parseMarkdown', () => {
  it('parses plain text with no formatting', () => {
    const result = parseMarkdown('Hello world')
    expect(result.rawText).toBe('Hello world')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]).toEqual({ text: 'Hello world', formatting: {} })
  })

  it('parses bold text', () => {
    const result = parseMarkdown('Hello **world**')
    expect(result.rawText).toBe('Hello world')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toEqual({ text: 'Hello ', formatting: {} })
    expect(result.segments[1]).toEqual({ text: 'world', formatting: { bold: true } })
  })

  it('parses italic text', () => {
    const result = parseMarkdown('Hello *world*')
    expect(result.rawText).toBe('Hello world')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[1]).toEqual({ text: 'world', formatting: { italic: true } })
  })

  it('parses strikethrough text', () => {
    const result = parseMarkdown('Hello ~~world~~')
    expect(result.rawText).toBe('Hello world')
    expect(result.segments[1]).toEqual({ text: 'world', formatting: { strikethrough: true } })
  })

  it('parses links', () => {
    const result = parseMarkdown('[Click here](https://example.com)')
    expect(result.rawText).toBe('Click here')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0]).toEqual({
      text: 'Click here',
      formatting: { link: 'https://example.com' },
    })
  })

  it('parses links with surrounding text', () => {
    const result = parseMarkdown('Please [click here](https://example.com) to continue')
    expect(result.rawText).toBe('Please click here to continue')
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]).toEqual({ text: 'Please ', formatting: {} })
    expect(result.segments[1]).toEqual({
      text: 'click here',
      formatting: { link: 'https://example.com' },
    })
    expect(result.segments[2]).toEqual({ text: ' to continue', formatting: {} })
  })

  it('parses bold + italic', () => {
    const result = parseMarkdown('***important***')
    expect(result.rawText).toBe('important')
    expect(result.segments[0]).toEqual({
      text: 'important',
      formatting: { bold: true, italic: true },
    })
  })

  it('parses mixed formatting', () => {
    const result = parseMarkdown('Normal **bold** and *italic* text')
    expect(result.rawText).toBe('Normal bold and italic text')
    expect(result.segments).toHaveLength(5)
  })

  it('handles empty string', () => {
    const result = parseMarkdown('')
    expect(result.rawText).toBe('')
    expect(result.segments).toHaveLength(0)
  })
})

describe('hasMarkdownFormatting', () => {
  it('returns true for links', () => {
    expect(hasMarkdownFormatting('[text](url)')).toBe(true)
  })

  it('returns true for bold', () => {
    expect(hasMarkdownFormatting('**bold**')).toBe(true)
  })

  it('returns true for italic', () => {
    expect(hasMarkdownFormatting('*italic*')).toBe(true)
  })

  it('returns true for strikethrough', () => {
    expect(hasMarkdownFormatting('~~strike~~')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(hasMarkdownFormatting('plain text')).toBe(false)
  })
})

describe('buildFormattingRequests', () => {
  it('builds bold request', () => {
    const requests = buildFormattingRequests(10, 20, { bold: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 20 },
        textStyle: { bold: true },
      },
    })
  })

  it('builds link request (plus text style reset)', () => {
    const requests = buildFormattingRequests(10, 20, { link: 'https://example.com' })
    // Should have text style reset + link request
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      updateTextStyle: {
        range: { startIndex: 10, endIndex: 20 },
        textStyle: { link: { url: 'https://example.com' } },
      },
    })
  })

  it('builds text style request and link request separately', () => {
    const requests = buildFormattingRequests(10, 20, { bold: true, link: 'https://example.com' })
    // 1 text style (with bold:true) + 1 link
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      updateTextStyle: { textStyle: { bold: true } },
    })
    expect(requests[1]).toMatchObject({
      updateTextStyle: { textStyle: { link: { url: 'https://example.com' } } },
    })
  })

  it('still applies text style reset for no formatting (prevents inheritance)', () => {
    const requests = buildFormattingRequests(10, 20, {})
    // Should still have one request to explicitly clear bold/italic/strikethrough
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      updateTextStyle: {
        textStyle: { bold: false, italic: false, strikethrough: false },
      },
    })
  })
})
