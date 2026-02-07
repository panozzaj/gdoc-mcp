import { getDocsClient, getDriveClient } from '../auth.js'
import { convertToMarkdown, findTextRange, findTableRange } from './converter.js'
import { getCachedRevision, setCachedRevision, NotReadError } from './concurrency.js'
import { extractDocId, extractFolderId } from '../types.js'
import {
  parseMarkdown,
  hasMarkdownFormatting,
  buildFormattingRequests,
  isMarkdownTable,
  parseMarkdownTable,
  buildInsertTableRequest,
} from './markdown.js'
import { generateDiff } from '../utils/diff.js'

export interface DocInfo {
  id: string
  title: string
  revisionId: string
}

export interface DocContent {
  id: string
  title: string
  content: string
  revisionId: string
}

export async function readDoc(
  docIdOrUrl: string,
  format: 'markdown' | 'json' = 'markdown',
): Promise<DocContent> {
  const docId = extractDocId(docIdOrUrl)
  const docs = await getDocsClient()

  const response = await docs.documents.get({ documentId: docId })
  const doc = response.data

  const revisionId = doc.revisionId || ''
  setCachedRevision(docId, revisionId)

  let content: string
  if (format === 'json') {
    content = JSON.stringify(doc, null, 2)
  } else {
    content = convertToMarkdown(doc)
  }

  return {
    id: docId,
    title: doc.title || 'Untitled',
    content,
    revisionId,
  }
}

export async function searchDoc(
  docIdOrUrl: string,
  query: string,
  context: number = 2,
  maxMatches: number = 10,
): Promise<string> {
  const docId = extractDocId(docIdOrUrl)
  const docs = await getDocsClient()

  const response = await docs.documents.get({ documentId: docId })
  const doc = response.data

  // Cache revision so edits work after search
  const revisionId = doc.revisionId || ''
  setCachedRevision(docId, revisionId)

  const content = convertToMarkdown(doc)
  const lines = content.split('\n')

  // Try as regex first, fall back to literal string
  let regex: RegExp
  try {
    regex = new RegExp(query, 'gi')
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  }

  const matches: { lineNum: number; line: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({ lineNum: i + 1, line: lines[i] })
      regex.lastIndex = 0 // Reset regex state
    }
    if (matches.length >= maxMatches) break
  }

  if (matches.length === 0) {
    return `No matches found for "${query}" in "${doc.title || 'Untitled'}"`
  }

  // Build output with context
  const output: string[] = [`# ${doc.title || 'Untitled'} - Search results for "${query}"`]
  output.push(`Found ${matches.length} match${matches.length > 1 ? 'es' : ''}:\n`)

  const shownLines = new Set<number>()

  for (const match of matches) {
    const startLine = Math.max(0, match.lineNum - 1 - context)
    const endLine = Math.min(lines.length, match.lineNum + context)

    // Add separator if there's a gap from previous shown lines
    if (shownLines.size > 0 && startLine > Math.max(...Array.from(shownLines)) + 1) {
      output.push('---')
    }

    for (let i = startLine; i < endLine; i++) {
      if (!shownLines.has(i)) {
        const lineNum = i + 1
        const prefix = lineNum === match.lineNum ? '>' : ' '
        output.push(`${prefix} ${lineNum}: ${lines[i]}`)
        shownLines.add(i)
      }
    }
  }

  return output.join('\n')
}

export async function editDoc(
  docIdOrUrl: string,
  oldText: string,
  newText: string,
): Promise<{ success: boolean; message: string }> {
  const docId = extractDocId(docIdOrUrl)
  const docs = await getDocsClient()

  // 1. Check if we've read this doc before (for discoverability, not locking)
  const cachedRevision = getCachedRevision(docId)
  if (!cachedRevision) {
    throw new NotReadError(docId)
  }

  // 2. Fetch current doc (may have changed since read - that's OK)
  const response = await docs.documents.get({ documentId: docId })
  const doc = response.data

  // 3. Check if old_text is a markdown table (table-to-table replacement)
  if (isMarkdownTable(oldText)) {
    const tableRange = findTableRange(doc, oldText)
    if (!tableRange) {
      throw new Error(
        `Table not found in document. The document may have been modified. Try reading it again.`,
      )
    }
    if (tableRange.matchCount > 1) {
      throw new Error(
        `Multiple matching tables found (${tableRange.matchCount}). Cannot determine which to replace.`,
      )
    }

    // Parse new table data
    const tableData = parseMarkdownTable(newText)
    if (!tableData) {
      throw new Error('new_text must also be a valid markdown table when replacing a table')
    }

    const numRows = tableData.rows.length + 1
    const numColumns = tableData.headers.length

    // Delete old table, insert new one
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [
          {
            deleteContentRange: {
              range: { startIndex: tableRange.startIndex, endIndex: tableRange.endIndex },
            },
          },
          buildInsertTableRequest(tableRange.startIndex, numRows, numColumns),
        ],
      },
    })

    // Get updated doc to find cell indices
    const updatedDoc = await docs.documents.get({ documentId: docId })
    const body = updatedDoc.data.body?.content || []

    const tableElement = body.find(
      (el: any) =>
        el.table && el.startIndex !== undefined && el.startIndex >= tableRange.startIndex,
    )

    if (tableElement?.table) {
      const cellRequests: object[] = []
      const tableRows = tableElement.table.tableRows || []
      const allRows = [tableData.headers, ...tableData.rows]

      for (let rowIdx = 0; rowIdx < tableRows.length && rowIdx < allRows.length; rowIdx++) {
        const cells = tableRows[rowIdx].tableCells || []
        const rowData = allRows[rowIdx]

        for (let colIdx = 0; colIdx < cells.length && colIdx < rowData.length; colIdx++) {
          const cell = cells[colIdx]
          const cellContent = cell.content?.[0]
          if (cellContent?.startIndex !== undefined && rowData[colIdx]) {
            cellRequests.push({
              insertText: {
                location: { index: cellContent.startIndex },
                text: rowData[colIdx],
              },
            })
          }
        }
      }

      if (cellRequests.length > 0) {
        // Sort by descending index so earlier insertions don't shift later indices
        cellRequests.sort(
          (a: any, b: any) => b.insertText.location.index - a.insertText.location.index,
        )
        await docs.documents.batchUpdate({
          documentId: docId,
          requestBody: { requests: cellRequests },
        })
      }
    }

    const finalDoc = await docs.documents.get({ documentId: docId })
    setCachedRevision(docId, finalDoc.data.revisionId || '')

    const diff = generateDiff(oldText, newText)
    return { success: true, message: diff.formatted }
  }

  // 4. Parse markdown from old_text to get raw text for matching
  const parsedOld = parseMarkdown(oldText)
  const searchText = parsedOld.rawText

  // 5. Find the text to replace (fails if text no longer exists or is ambiguous)
  const range = findTextRange(doc, searchText)
  if (!range) {
    const displayText = hasMarkdownFormatting(oldText)
      ? `${oldText} (raw: "${searchText}")`
      : oldText
    throw new Error(
      `Text not found in document: "${displayText.slice(0, 100)}${displayText.length > 100 ? '...' : ''}"\n` +
        `The document may have been modified. Try reading it again.`,
    )
  }

  if (range.matchCount > 1) {
    throw new Error(
      `Text appears ${range.matchCount} times in document: "${searchText.slice(0, 50)}${searchText.length > 50 ? '...' : ''}"\n` +
        `Provide more surrounding context to make the match unique.`,
    )
  }

  // 6. Check if new_text is a markdown table (special handling required)
  if (isMarkdownTable(newText)) {
    const tableData = parseMarkdownTable(newText)
    if (tableData) {
      // Tables require multi-step insertion:
      // Step 1: Delete old content and insert table structure
      const numRows = tableData.rows.length + 1 // +1 for header
      const numColumns = tableData.headers.length

      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [
            {
              deleteContentRange: {
                range: { startIndex: range.startIndex, endIndex: range.endIndex },
              },
            },
            buildInsertTableRequest(range.startIndex, numRows, numColumns),
          ],
        },
      })

      // Step 2: Get updated doc to find cell indices
      const updatedDoc = await docs.documents.get({ documentId: docId })
      const body = updatedDoc.data.body?.content || []

      // Find the table we just inserted
      const tableElement = body.find(
        (el: any) => el.table && el.startIndex !== undefined && el.startIndex >= range.startIndex,
      )

      if (tableElement?.table) {
        const cellRequests: object[] = []
        const tableRows = tableElement.table.tableRows || []

        // Insert cell content (header row first, then data rows)
        const allRows = [tableData.headers, ...tableData.rows]
        for (let rowIdx = 0; rowIdx < tableRows.length && rowIdx < allRows.length; rowIdx++) {
          const cells = tableRows[rowIdx].tableCells || []
          const rowData = allRows[rowIdx]

          for (let colIdx = 0; colIdx < cells.length && colIdx < rowData.length; colIdx++) {
            const cell = cells[colIdx]
            const cellContent = cell.content?.[0]
            if (cellContent?.startIndex !== undefined && rowData[colIdx]) {
              cellRequests.push({
                insertText: {
                  location: { index: cellContent.startIndex },
                  text: rowData[colIdx],
                },
              })
            }
          }
        }

        if (cellRequests.length > 0) {
          // Sort by descending index so earlier insertions don't shift later indices
          cellRequests.sort(
            (a: any, b: any) => b.insertText.location.index - a.insertText.location.index,
          )
          await docs.documents.batchUpdate({
            documentId: docId,
            requestBody: { requests: cellRequests },
          })
        }
      }

      // Update cached revision
      const finalDoc = await docs.documents.get({ documentId: docId })
      setCachedRevision(docId, finalDoc.data.revisionId || '')

      const diff = generateDiff(oldText, newText)
      return { success: true, message: diff.formatted }
    }
  }

  // 6. Parse markdown from new_text to get raw text and formatting
  const parsedNew = parseMarkdown(newText)

  // 7. Build requests: delete old, insert new text, then apply formatting
  const requests: object[] = [
    {
      deleteContentRange: {
        range: {
          startIndex: range.startIndex,
          endIndex: range.endIndex,
        },
      },
    },
    {
      insertText: {
        location: { index: range.startIndex },
        text: parsedNew.rawText,
      },
    },
  ]

  // 8. Add formatting requests for each segment
  let currentIndex = range.startIndex
  for (const segment of parsedNew.segments) {
    const segmentEnd = currentIndex + segment.text.length
    const formatRequests = buildFormattingRequests(currentIndex, segmentEnd, segment.formatting)
    requests.push(...formatRequests)
    currentIndex = segmentEnd
  }

  // 9. Apply all changes in one batch
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  })

  // 10. Update the cached revision
  const updated = await docs.documents.get({ documentId: docId })
  const newRevision = updated.data.revisionId || ''
  setCachedRevision(docId, newRevision)

  const diff = generateDiff(oldText, newText)
  return { success: true, message: diff.formatted }
}

export async function getDocInfo(docIdOrUrl: string): Promise<DocInfo> {
  const docId = extractDocId(docIdOrUrl)
  const docs = await getDocsClient()

  const response = await docs.documents.get({ documentId: docId })
  const doc = response.data

  return {
    id: docId,
    title: doc.title || 'Untitled',
    revisionId: doc.revisionId || '',
  }
}

export async function listDocs(
  query?: string,
  limit: number = 10,
): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  const drive = await getDriveClient()

  let q = "mimeType='application/vnd.google-apps.document'"
  if (query) {
    q += ` and name contains '${query.replace(/'/g, "\\'")}'`
  }

  const response = await drive.files.list({
    q,
    pageSize: limit,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, modifiedTime)',
  })

  return (response.data.files || []).map((f) => ({
    id: f.id || '',
    name: f.name || 'Untitled',
    modifiedTime: f.modifiedTime || '',
  }))
}

export async function createDoc(
  title: string,
  folderIdOrUrl?: string,
): Promise<{ id: string; title: string; url: string }> {
  const drive = await getDriveClient()

  const requestBody: { name: string; mimeType: string; parents?: string[] } = {
    name: title,
    mimeType: 'application/vnd.google-apps.document',
  }
  if (folderIdOrUrl) {
    requestBody.parents = [extractFolderId(folderIdOrUrl)]
  }

  const response = await drive.files.create({
    requestBody,
    fields: 'id, name',
  })

  const id = response.data.id || ''
  return {
    id,
    title: response.data.name || title,
    url: `https://docs.google.com/document/d/${id}/edit`,
  }
}

export async function copyDoc(
  docIdOrUrl: string,
  title?: string,
  folderIdOrUrl?: string,
): Promise<{ id: string; title: string; url: string }> {
  const docId = extractDocId(docIdOrUrl)
  const drive = await getDriveClient()

  const requestBody: { name?: string; parents?: string[] } = {}
  if (title) {
    requestBody.name = title
  }
  if (folderIdOrUrl) {
    requestBody.parents = [extractFolderId(folderIdOrUrl)]
  }

  const response = await drive.files.copy({
    fileId: docId,
    requestBody,
    fields: 'id, name',
  })

  const id = response.data.id || ''
  return {
    id,
    title: response.data.name || title || 'Copy',
    url: `https://docs.google.com/document/d/${id}/edit`,
  }
}
