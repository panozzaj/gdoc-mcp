import { getGmailClient } from '../auth.js'
import { gmail_v1 } from 'googleapis'
import * as fs from 'fs'
import * as path from 'path'

export interface EmailSummary {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  date: string
  snippet: string
}

export interface EmailMessage {
  id: string
  threadId: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  body: string
  labels: string[]
}

export interface DraftInfo {
  draftId: string
  messageId: string
  threadId: string
  subject: string
  to: string
}

export interface DraftSummary {
  draftId: string
  messageId: string
  to: string
  subject: string
  snippet: string
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  if (!headers) return ''
  const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
  return header?.value || ''
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ''

  // Single-part message
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64url').toString('utf-8')
    if (payload.mimeType === 'text/html') {
      return stripHtml(decoded)
    }
    return decoded
  }

  // Multipart message - walk MIME tree
  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      }
    }
    // Fall back to text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(Buffer.from(part.body.data, 'base64url').toString('utf-8'))
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/')) {
        const result = extractBody(part)
        if (result) return result
      }
    }
  }

  return ''
}

export interface AttachmentInfo {
  filename: string
  mimeType: string
  size: number
  attachmentId: string
  partId: string
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function buildRawMessage(
  to: string,
  subject: string,
  body: string,
  extraHeaders?: Record<string, string>,
  attachments?: string[],
): string {
  const headerLines = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0']

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headerLines.push(`${key}: ${value}`)
    }
  }

  if (!attachments || attachments.length === 0) {
    headerLines.push('Content-Type: text/plain; charset="UTF-8"')
    headerLines.push('', body)
    const raw = headerLines.join('\r\n')
    return Buffer.from(raw).toString('base64url')
  }

  // Multipart message with attachments
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`
  headerLines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  headerLines.push('')

  const parts: string[] = []

  // Text body part
  parts.push(`--${boundary}`)
  parts.push('Content-Type: text/plain; charset="UTF-8"')
  parts.push('')
  parts.push(body)

  // Attachment parts
  for (const filePath of attachments) {
    const resolvedPath = path.resolve(filePath)
    const fileData = fs.readFileSync(resolvedPath)
    const fileName = path.basename(resolvedPath)
    const mimeType = getMimeType(resolvedPath)
    const base64Data = fileData.toString('base64')

    parts.push(`--${boundary}`)
    parts.push(`Content-Type: ${mimeType}; name="${fileName}"`)
    parts.push('Content-Transfer-Encoding: base64')
    parts.push(`Content-Disposition: attachment; filename="${fileName}"`)
    parts.push('')
    parts.push(base64Data)
  }

  parts.push(`--${boundary}--`)

  const raw = headerLines.join('\r\n') + '\r\n' + parts.join('\r\n')
  return Buffer.from(raw).toString('base64url')
}

export async function listMessages(
  query?: string,
  maxResults: number = 10,
): Promise<EmailSummary[]> {
  const gmail = await getGmailClient()
  const cappedMax = Math.min(maxResults, 50)

  const listResponse = await gmail.users.messages.list({
    userId: 'me',
    q: query || undefined,
    maxResults: cappedMax,
  })

  const messageIds = listResponse.data.messages || []
  if (messageIds.length === 0) return []

  const summaries: EmailSummary[] = []
  for (const msg of messageIds) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'METADATA',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    })

    const headers = detail.data.payload?.headers
    summaries.push({
      id: detail.data.id || '',
      threadId: detail.data.threadId || '',
      from: getHeader(headers, 'From'),
      to: getHeader(headers, 'To'),
      subject: getHeader(headers, 'Subject'),
      date: getHeader(headers, 'Date'),
      snippet: detail.data.snippet || '',
    })
  }

  return summaries
}

export async function listDrafts(maxResults: number = 10): Promise<DraftSummary[]> {
  const gmail = await getGmailClient()
  const cappedMax = Math.min(maxResults, 50)

  const listResponse = await gmail.users.drafts.list({
    userId: 'me',
    maxResults: cappedMax,
  })

  const drafts = listResponse.data.drafts || []
  if (drafts.length === 0) return []

  const summaries: DraftSummary[] = []
  for (const draft of drafts) {
    const detail = await gmail.users.drafts.get({
      userId: 'me',
      id: draft.id!,
      format: 'METADATA',
    })

    const headers = detail.data.message?.payload?.headers
    summaries.push({
      draftId: detail.data.id || '',
      messageId: detail.data.message?.id || '',
      to: getHeader(headers, 'To'),
      subject: getHeader(headers, 'Subject'),
      snippet: detail.data.message?.snippet || '',
    })
  }

  return summaries
}

export async function readMessage(messageId: string): Promise<EmailMessage> {
  const gmail = await getGmailClient()

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'FULL',
  })

  const headers = response.data.payload?.headers
  const body = extractBody(response.data.payload)

  return {
    id: response.data.id || '',
    threadId: response.data.threadId || '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    subject: getHeader(headers, 'Subject'),
    date: getHeader(headers, 'Date'),
    body,
    labels: response.data.labelIds || [],
  }
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): AttachmentInfo[] {
  if (!payload) return []

  const attachments: AttachmentInfo[] = []

  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      mimeType: payload.mimeType || 'application/octet-stream',
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
      partId: payload.partId || '',
    })
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...extractAttachments(part))
    }
  }

  return attachments
}

export async function listAttachments(messageId: string): Promise<AttachmentInfo[]> {
  const gmail = await getGmailClient()

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'FULL',
  })

  return extractAttachments(response.data.payload)
}

export async function saveAttachment(
  messageId: string,
  attachmentId: string,
  savePath: string,
): Promise<string> {
  const gmail = await getGmailClient()

  const response = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  })

  const data = response.data.data
  if (!data) throw new Error('Attachment data is empty')

  const resolvedPath = path.resolve(savePath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, Buffer.from(data, 'base64url'))

  return resolvedPath
}

export async function deleteDraft(draftId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.drafts.delete({ userId: 'me', id: draftId })
}

export async function createDraft(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
  attachments?: string[],
): Promise<DraftInfo> {
  const gmail = await getGmailClient()

  const extraHeaders: Record<string, string> = {}
  if (cc) extraHeaders['Cc'] = cc
  if (bcc) extraHeaders['Bcc'] = bcc

  const raw = buildRawMessage(
    to,
    subject,
    body,
    Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    attachments,
  )

  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw },
    },
  })

  const draftMessage = response.data.message
  return {
    draftId: response.data.id || '',
    messageId: draftMessage?.id || '',
    threadId: draftMessage?.threadId || '',
    subject,
    to,
  }
}

export async function createReplyDraft(messageId: string, body: string): Promise<DraftInfo> {
  const gmail = await getGmailClient()

  // Fetch the original message to get threading headers
  const original = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'METADATA',
    metadataHeaders: ['From', 'To', 'Subject', 'Message-ID'],
  })

  const headers = original.data.payload?.headers
  const originalFrom = getHeader(headers, 'From')
  const originalSubject = getHeader(headers, 'Subject')
  const originalMessageId = getHeader(headers, 'Message-ID')
  const threadId = original.data.threadId || ''

  const replySubject = originalSubject.startsWith('Re:')
    ? originalSubject
    : `Re: ${originalSubject}`

  const extraHeaders: Record<string, string> = {}
  if (originalMessageId) {
    extraHeaders['In-Reply-To'] = originalMessageId
    extraHeaders['References'] = originalMessageId
  }

  const raw = buildRawMessage(originalFrom, replySubject, body, extraHeaders)

  const response = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw, threadId },
    },
  })

  const draftMessage = response.data.message
  return {
    draftId: response.data.id || '',
    messageId: draftMessage?.id || '',
    threadId: draftMessage?.threadId || '',
    subject: replySubject,
    to: originalFrom,
  }
}

export async function updateDraft(
  draftId: string,
  updates: { to?: string; subject?: string; body?: string; cc?: string; bcc?: string },
): Promise<DraftInfo> {
  const gmail = await getGmailClient()

  // Fetch the existing draft to get current values
  const existing = await gmail.users.drafts.get({
    userId: 'me',
    id: draftId,
    format: 'FULL',
  })

  const existingHeaders = existing.data.message?.payload?.headers
  const existingBody = extractBody(existing.data.message?.payload)
  const existingThreadId = existing.data.message?.threadId || ''

  const to = updates.to || getHeader(existingHeaders, 'To')
  const subject = updates.subject || getHeader(existingHeaders, 'Subject')
  const body = updates.body !== undefined ? updates.body : existingBody
  const cc = updates.cc !== undefined ? updates.cc : getHeader(existingHeaders, 'Cc')
  const bcc = updates.bcc !== undefined ? updates.bcc : getHeader(existingHeaders, 'Bcc')

  // Preserve threading headers if they exist
  const extraHeaders: Record<string, string> = {}
  const inReplyTo = getHeader(existingHeaders, 'In-Reply-To')
  const references = getHeader(existingHeaders, 'References')
  if (inReplyTo) extraHeaders['In-Reply-To'] = inReplyTo
  if (references) extraHeaders['References'] = references
  if (cc) extraHeaders['Cc'] = cc
  if (bcc) extraHeaders['Bcc'] = bcc

  const raw = buildRawMessage(
    to,
    subject,
    body,
    Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
  )

  const response = await gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: {
      message: { raw, threadId: existingThreadId || undefined },
    },
  })

  const draftMessage = response.data.message
  return {
    draftId: response.data.id || '',
    messageId: draftMessage?.id || '',
    threadId: draftMessage?.threadId || '',
    subject,
    to,
  }
}
