import { docs_v1 } from 'googleapis'

type Document = docs_v1.Schema$Document
type StructuralElement = docs_v1.Schema$StructuralElement
type Paragraph = docs_v1.Schema$Paragraph
type ParagraphElement = docs_v1.Schema$ParagraphElement
type TextRun = docs_v1.Schema$TextRun
type Table = docs_v1.Schema$Table

export function convertToMarkdown(doc: Document): string {
  const body = doc.body
  if (!body?.content) return ''

  const lines: string[] = []

  for (const element of body.content) {
    const converted = convertStructuralElement(element)
    if (converted) {
      lines.push(converted)
    }
  }

  return lines.join('\n')
}

function convertStructuralElement(element: StructuralElement): string {
  if (element.paragraph) {
    return convertParagraph(element.paragraph)
  }
  if (element.table) {
    return convertTable(element.table)
  }
  if (element.sectionBreak) {
    return '\n---\n'
  }
  return ''
}

function convertParagraph(para: Paragraph): string {
  const style = para.paragraphStyle?.namedStyleType
  const bullet = para.bullet

  let text = ''
  for (const elem of para.elements || []) {
    text += convertParagraphElement(elem)
  }

  // Trim trailing newline that Google Docs adds
  text = text.replace(/\n$/, '')

  if (!text.trim()) return ''

  // Handle headings
  if (style?.startsWith('HEADING_')) {
    const level = parseInt(style.replace('HEADING_', ''), 10)
    const prefix = '#'.repeat(Math.min(level, 6))
    return `${prefix} ${text}`
  }
  if (style === 'TITLE') {
    return `# ${text}`
  }
  if (style === 'SUBTITLE') {
    return `## ${text}`
  }

  // Handle lists
  if (bullet) {
    const nestingLevel = bullet.nestingLevel || 0
    const indent = '  '.repeat(nestingLevel)
    // Check if it's a numbered list by looking at glyphType
    const isNumbered = bullet.listId && para.paragraphStyle?.indentFirstLine
    const marker = isNumbered ? '1.' : '-'
    return `${indent}${marker} ${text}`
  }

  return text
}

function convertParagraphElement(elem: ParagraphElement): string {
  if (elem.textRun) {
    return convertTextRun(elem.textRun)
  }
  if (elem.inlineObjectElement) {
    // Preserve image reference as HTML comment
    const objectId = elem.inlineObjectElement.inlineObjectId
    return `<!-- gdoc:image id="${objectId}" -->`
  }
  return ''
}

function convertTextRun(run: TextRun): string {
  let text = run.content || ''
  const style = run.textStyle

  if (!style || !text.trim()) return text

  // Apply formatting (innermost to outermost)
  if (style.underline) {
    text = `<u>${text.trim()}</u>`
    if (run.content?.endsWith(' ')) text += ' '
  }
  if (style.strikethrough) {
    text = `~~${text.trim()}~~`
    if (run.content?.endsWith(' ')) text += ' '
  }
  if (style.italic) {
    text = `*${text.trim()}*`
    if (run.content?.endsWith(' ')) text += ' '
  }
  if (style.bold) {
    text = `**${text.trim()}**`
    if (run.content?.endsWith(' ')) text += ' '
  }
  if (style.link?.url) {
    text = `[${text.trim()}](${style.link.url})`
    if (run.content?.endsWith(' ')) text += ' '
  }

  return text
}

function convertTable(table: Table): string {
  const rows = table.tableRows || []
  if (rows.length === 0) return ''

  const lines: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const cells = row.tableCells || []
    const cellTexts = cells.map((cell) => {
      const content = cell.content || []
      return content
        .map((elem) => convertStructuralElement(elem))
        .join(' ')
        .replace(/\n/g, ' ')
        .trim()
    })

    lines.push(`| ${cellTexts.join(' | ')} |`)

    // Add header separator after first row
    if (i === 0) {
      const separator = cells.map(() => '---').join(' | ')
      lines.push(`| ${separator} |`)
    }
  }

  return lines.join('\n')
}

// Find a table in the document that matches the given markdown table content
// Returns the table's range if found
export function findTableRange(
  doc: Document,
  tableMarkdown: string,
): { startIndex: number; endIndex: number; matchCount: number } | null {
  const body = doc.body
  if (!body?.content) return null

  // Normalize the search markdown (remove extra whitespace, normalize separators)
  const normalizeTable = (md: string): string => {
    return md
      .split('\n')
      .filter((line) => !/^\|\s*[-:]+/.test(line)) // Remove separator rows
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n')
  }

  const searchNormalized = normalizeTable(tableMarkdown)
  let matchCount = 0
  let matchedElement: any = null

  for (const element of body.content) {
    if (element.table) {
      const tableMarkdownContent = convertTable(element.table)
      const tableNormalized = normalizeTable(tableMarkdownContent)

      if (tableNormalized === searchNormalized) {
        matchCount++
        if (matchCount === 1) {
          matchedElement = element
        }
      }
    }
  }

  if (!matchedElement) return null

  return {
    startIndex: matchedElement.startIndex,
    endIndex: matchedElement.endIndex,
    matchCount,
  }
}

// Find text in document and return its range
// Throws if text appears multiple times (require unique match like Claude Code's Edit tool)
export function findTextRange(
  doc: Document,
  searchText: string,
): { startIndex: number; endIndex: number; matchCount: number } | null {
  const body = doc.body
  if (!body?.content) return null

  // Build full document text with index tracking
  let fullText = ''
  const indexMap: number[] = [] // maps string position to doc index

  function appendParagraphText(paragraph: Paragraph): void {
    for (const elem of paragraph.elements || []) {
      if (elem.textRun?.content) {
        const startIdx = elem.startIndex || 0
        for (let i = 0; i < elem.textRun.content.length; i++) {
          indexMap.push(startIdx + i)
        }
        fullText += elem.textRun.content
      }
    }
  }

  function appendTextFromElement(element: StructuralElement): void {
    if (element.paragraph) {
      appendParagraphText(element.paragraph)
    }
    if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellElement of cell.content || []) {
            appendTextFromElement(cellElement)
          }
        }
      }
    }
  }

  for (const element of body.content) {
    appendTextFromElement(element)
  }

  // First try exact match
  let matchCount = 0
  let pos = -1
  let searchPos = 0
  while ((searchPos = fullText.indexOf(searchText, searchPos)) !== -1) {
    if (matchCount === 0) pos = searchPos
    matchCount++
    searchPos += 1
  }

  if (pos !== -1) {
    return {
      startIndex: indexMap[pos],
      endIndex: indexMap[pos + searchText.length - 1] + 1,
      matchCount,
    }
  }

  // If exact match fails, try with normalized whitespace
  // This handles cases where markdown shows consecutive lines but doc has blank paragraphs
  const normalizedSearch = searchText.replace(/\n+/g, '\n')
  const normalizedFull = fullText.replace(/\n+/g, '\n')

  // Build mapping from normalized positions back to original
  const normToOrigMap: number[] = []
  let normIdx = 0
  for (let i = 0; i < fullText.length; i++) {
    if (fullText[i] === '\n' && i > 0 && fullText[i - 1] === '\n') {
      continue // Skip consecutive newlines
    }
    normToOrigMap[normIdx] = i
    normIdx++
  }

  matchCount = 0
  pos = -1
  searchPos = 0
  while ((searchPos = normalizedFull.indexOf(normalizedSearch, searchPos)) !== -1) {
    if (matchCount === 0) pos = searchPos
    matchCount++
    searchPos += 1
  }

  if (pos === -1) return null

  // Map back to original indices
  const origStart = normToOrigMap[pos]
  const origEnd = normToOrigMap[pos + normalizedSearch.length - 1]

  return {
    startIndex: indexMap[origStart],
    endIndex: indexMap[origEnd] + 1,
    matchCount,
  }
}
