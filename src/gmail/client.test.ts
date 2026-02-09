import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  listMessages,
  listDrafts,
  readMessage,
  listAttachments,
  saveAttachment,
  createDraft,
  createReplyDraft,
  updateDraft,
  deleteDraft,
} from './client.js'
import * as fs from 'fs'

vi.mock('../auth.js', () => ({
  getGmailClient: vi.fn(),
}))

import { getGmailClient } from '../auth.js'

function createMockMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    snippet: 'Hello, this is a test...',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'alice@example.com' },
        { name: 'To', value: 'bob@example.com' },
        { name: 'Cc', value: 'charlie@example.com' },
        { name: 'Subject', value: 'Test Subject' },
        { name: 'Date', value: 'Mon, 15 Jun 2025 10:00:00 -0400' },
        { name: 'Message-ID', value: '<abc123@example.com>' },
      ],
      body: {
        data: Buffer.from('Hello, this is a test message.').toString('base64url'),
      },
    },
    ...overrides,
  }
}

describe('Gmail Client', () => {
  let mockGmailClient: {
    users: {
      messages: {
        list: ReturnType<typeof vi.fn>
        get: ReturnType<typeof vi.fn>
        attachments: {
          get: ReturnType<typeof vi.fn>
        }
      }
      drafts: {
        list: ReturnType<typeof vi.fn>
        create: ReturnType<typeof vi.fn>
        get: ReturnType<typeof vi.fn>
        update: ReturnType<typeof vi.fn>
        delete: ReturnType<typeof vi.fn>
      }
    }
  }

  beforeEach(() => {
    mockGmailClient = {
      users: {
        messages: {
          list: vi.fn(),
          get: vi.fn(),
          attachments: {
            get: vi.fn(),
          },
        },
        drafts: {
          list: vi.fn(),
          create: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      },
    }

    vi.mocked(getGmailClient).mockResolvedValue(mockGmailClient as any)
  })

  describe('listMessages', () => {
    it('returns message summaries', async () => {
      mockGmailClient.users.messages.list.mockResolvedValue({
        data: {
          messages: [{ id: 'msg-1' }, { id: 'msg-2' }],
        },
      })

      mockGmailClient.users.messages.get
        .mockResolvedValueOnce({
          data: createMockMessage({ id: 'msg-1' }),
        })
        .mockResolvedValueOnce({
          data: createMockMessage({ id: 'msg-2', snippet: 'Second message' }),
        })

      const result = await listMessages()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('msg-1')
      expect(result[0].from).toBe('alice@example.com')
      expect(result[0].subject).toBe('Test Subject')
      expect(result[1].id).toBe('msg-2')
    })

    it('passes query to API', async () => {
      mockGmailClient.users.messages.list.mockResolvedValue({
        data: { messages: [] },
      })

      await listMessages('from:alice@example.com')

      expect(mockGmailClient.users.messages.list).toHaveBeenCalledWith({
        userId: 'me',
        q: 'from:alice@example.com',
        maxResults: 10,
      })
    })

    it('handles empty results', async () => {
      mockGmailClient.users.messages.list.mockResolvedValue({
        data: { messages: undefined },
      })

      const result = await listMessages()
      expect(result).toHaveLength(0)
    })

    it('caps maxResults at 50', async () => {
      mockGmailClient.users.messages.list.mockResolvedValue({
        data: { messages: [] },
      })

      await listMessages(undefined, 100)

      expect(mockGmailClient.users.messages.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 50 }),
      )
    })

    it('passes undefined query when not specified', async () => {
      mockGmailClient.users.messages.list.mockResolvedValue({
        data: { messages: [] },
      })

      await listMessages()

      expect(mockGmailClient.users.messages.list).toHaveBeenCalledWith({
        userId: 'me',
        q: undefined,
        maxResults: 10,
      })
    })
  })

  describe('readMessage', () => {
    it('returns full message with plain text body', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage(),
      })

      const result = await readMessage('msg-1')

      expect(result.id).toBe('msg-1')
      expect(result.threadId).toBe('thread-1')
      expect(result.from).toBe('alice@example.com')
      expect(result.to).toBe('bob@example.com')
      expect(result.cc).toBe('charlie@example.com')
      expect(result.subject).toBe('Test Subject')
      expect(result.body).toBe('Hello, this is a test message.')
      expect(result.labels).toEqual(['INBOX', 'UNREAD'])
    })

    it('extracts body from multipart message', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'alice@example.com' },
              { name: 'To', value: 'bob@example.com' },
              { name: 'Subject', value: 'Multipart Test' },
              { name: 'Date', value: 'Mon, 15 Jun 2025 10:00:00 -0400' },
            ],
            body: {},
            parts: [
              {
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Plain text version').toString('base64url'),
                },
              },
              {
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>HTML version</p>').toString('base64url'),
                },
              },
            ],
          },
        }),
      })

      const result = await readMessage('msg-1')
      expect(result.body).toBe('Plain text version')
    })

    it('falls back to HTML when no plain text part', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'alice@example.com' },
              { name: 'To', value: 'bob@example.com' },
              { name: 'Subject', value: 'HTML Only' },
              { name: 'Date', value: 'Mon, 15 Jun 2025 10:00:00 -0400' },
            ],
            body: {},
            parts: [
              {
                mimeType: 'text/html',
                body: {
                  data: Buffer.from(
                    '<p>Hello <b>world</b></p><br><p>Second paragraph</p>',
                  ).toString('base64url'),
                },
              },
            ],
          },
        }),
      })

      const result = await readMessage('msg-1')
      expect(result.body).toContain('Hello world')
      expect(result.body).toContain('Second paragraph')
      expect(result.body).not.toContain('<p>')
      expect(result.body).not.toContain('<b>')
    })

    it('handles single-part HTML message', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'text/html',
            headers: [
              { name: 'From', value: 'alice@example.com' },
              { name: 'To', value: 'bob@example.com' },
              { name: 'Subject', value: 'HTML Single Part' },
              { name: 'Date', value: 'Mon, 15 Jun 2025 10:00:00 -0400' },
            ],
            body: {
              data: Buffer.from('<div>Simple &amp; clean</div>').toString('base64url'),
            },
          },
        }),
      })

      const result = await readMessage('msg-1')
      expect(result.body).toBe('Simple & clean')
    })

    it('recurses into nested multipart', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'alice@example.com' },
              { name: 'To', value: 'bob@example.com' },
              { name: 'Subject', value: 'Nested' },
              { name: 'Date', value: 'Mon, 15 Jun 2025 10:00:00 -0400' },
            ],
            body: {},
            parts: [
              {
                mimeType: 'multipart/alternative',
                body: {},
                parts: [
                  {
                    mimeType: 'text/plain',
                    body: {
                      data: Buffer.from('Nested plain text').toString('base64url'),
                    },
                  },
                ],
              },
              {
                mimeType: 'application/pdf',
                filename: 'doc.pdf',
                body: { attachmentId: 'att-1' },
              },
            ],
          },
        }),
      })

      const result = await readMessage('msg-1')
      expect(result.body).toBe('Nested plain text')
    })

    it('passes correct params to API', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage(),
      })

      await readMessage('msg-123')

      expect(mockGmailClient.users.messages.get).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-123',
        format: 'FULL',
      })
    })

    it('handles missing headers gracefully', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'text/plain',
            headers: [],
            body: {
              data: Buffer.from('Body text').toString('base64url'),
            },
          },
        }),
      })

      const result = await readMessage('msg-1')
      expect(result.from).toBe('')
      expect(result.to).toBe('')
      expect(result.subject).toBe('')
    })
  })

  describe('createDraft', () => {
    it('creates a new draft', async () => {
      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-new' },
        },
      })

      const result = await createDraft('bob@example.com', 'Hello', 'Hi Bob!')

      expect(result.draftId).toBe('draft-1')
      expect(result.messageId).toBe('draft-msg-1')
      expect(result.threadId).toBe('thread-new')
      expect(result.subject).toBe('Hello')
      expect(result.to).toBe('bob@example.com')

      expect(mockGmailClient.users.drafts.create).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: {
          message: { raw: expect.any(String) },
        },
      })

      // Verify the raw message content
      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('To: bob@example.com')
      expect(decoded).toContain('Subject: Hello')
      expect(decoded).toContain('Hi Bob!')
    })

    it('includes CC header when provided', async () => {
      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await createDraft('bob@example.com', 'Hello', 'Hi!', 'charlie@example.com')

      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Cc: charlie@example.com')
    })

    it('omits CC header when not provided', async () => {
      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await createDraft('bob@example.com', 'Hello', 'Hi!')

      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).not.toContain('Cc:')
    })

    it('includes BCC header when provided', async () => {
      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await createDraft('bob@example.com', 'Hello', 'Hi!', undefined, 'secret@example.com')

      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Bcc: secret@example.com')
    })
  })

  describe('createReplyDraft', () => {
    it('creates a reply draft with threading headers', async () => {
      // Mock fetching original message
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage(),
      })

      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-reply-1',
          message: { id: 'draft-msg-2', threadId: 'thread-1' },
        },
      })

      const result = await createReplyDraft('msg-1', 'Thanks for your message!')

      expect(result.draftId).toBe('draft-reply-1')
      expect(result.threadId).toBe('thread-1')
      expect(result.subject).toBe('Re: Test Subject')
      expect(result.to).toBe('alice@example.com')

      // Verify the draft was created with threadId
      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      expect(call.requestBody.message.threadId).toBe('thread-1')

      // Verify threading headers
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('In-Reply-To: <abc123@example.com>')
      expect(decoded).toContain('References: <abc123@example.com>')
      expect(decoded).toContain('Subject: Re: Test Subject')
      expect(decoded).toContain('To: alice@example.com')
    })

    it('does not double-prefix Re: in subject', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            ...createMockMessage().payload,
            headers: [
              { name: 'From', value: 'alice@example.com' },
              { name: 'Subject', value: 'Re: Already a reply' },
              { name: 'Message-ID', value: '<abc@example.com>' },
            ],
          },
        }),
      })

      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'msg-1', threadId: 'thread-1' },
        },
      })

      const result = await createReplyDraft('msg-1', 'Reply body')

      expect(result.subject).toBe('Re: Already a reply')
    })

    it('fetches original message with correct params', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage(),
      })

      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'msg-1', threadId: 'thread-1' },
        },
      })

      await createReplyDraft('original-msg-id', 'Reply')

      expect(mockGmailClient.users.messages.get).toHaveBeenCalledWith({
        userId: 'me',
        id: 'original-msg-id',
        format: 'METADATA',
        metadataHeaders: ['From', 'To', 'Subject', 'Message-ID'],
      })
    })
  })

  describe('updateDraft', () => {
    it('fetches existing draft and merges updates', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: createMockMessage({
            threadId: 'thread-1',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Original Subject' },
                { name: 'Cc', value: '' },
              ],
              body: {
                data: Buffer.from('Original body').toString('base64url'),
              },
            },
          }),
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      const result = await updateDraft('draft-1', { subject: 'Updated Subject' })

      expect(result.draftId).toBe('draft-1')
      expect(result.subject).toBe('Updated Subject')
      expect(result.to).toBe('bob@example.com')

      // Verify the raw message contains merged content
      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Subject: Updated Subject')
      expect(decoded).toContain('To: bob@example.com')
      expect(decoded).toContain('Original body')
    })

    it('updates body while keeping other fields', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: createMockMessage({
            threadId: 'thread-1',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Keep This' },
              ],
              body: {
                data: Buffer.from('Old body').toString('base64url'),
              },
            },
          }),
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await updateDraft('draft-1', { body: 'New body content' })

      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Subject: Keep This')
      expect(decoded).toContain('New body content')
      expect(decoded).not.toContain('Old body')
    })

    it('preserves threading headers from existing draft', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: createMockMessage({
            threadId: 'thread-1',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Re: Thread' },
                { name: 'In-Reply-To', value: '<original@example.com>' },
                { name: 'References', value: '<original@example.com>' },
              ],
              body: {
                data: Buffer.from('Reply body').toString('base64url'),
              },
            },
          }),
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await updateDraft('draft-1', { body: 'Updated reply' })

      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('In-Reply-To: <original@example.com>')
      expect(decoded).toContain('References: <original@example.com>')
      expect(call.requestBody.message.threadId).toBe('thread-1')
    })

    it('updates all fields at once', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: createMockMessage({
            threadId: '',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'To', value: 'old@example.com' },
                { name: 'Subject', value: 'Old Subject' },
              ],
              body: {
                data: Buffer.from('Old body').toString('base64url'),
              },
            },
          }),
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: '' },
        },
      })

      const result = await updateDraft('draft-1', {
        to: 'new@example.com',
        subject: 'New Subject',
        body: 'New body',
        cc: 'cc@example.com',
      })

      expect(result.to).toBe('new@example.com')
      expect(result.subject).toBe('New Subject')

      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('To: new@example.com')
      expect(decoded).toContain('Subject: New Subject')
      expect(decoded).toContain('New body')
      expect(decoded).toContain('Cc: cc@example.com')
    })

    it('preserves existing attachments by default', async () => {
      const attachmentContent = 'PDF file data here'
      const attachmentBase64url = Buffer.from(attachmentContent).toString('base64url')

      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: {
            id: 'draft-msg-1',
            threadId: 'thread-1',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'With Attachment' },
              ],
              body: {},
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Original body').toString('base64url'),
                  },
                },
                {
                  mimeType: 'application/pdf',
                  filename: 'report.pdf',
                  body: {
                    attachmentId: 'att-1',
                    size: 1000,
                  },
                },
              ],
            },
          },
        },
      })

      // Mock fetching the attachment data
      mockGmailClient.users.messages.attachments.get.mockResolvedValue({
        data: { data: attachmentBase64url },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await updateDraft('draft-1', { subject: 'Updated Subject' })

      // Verify attachment data was fetched
      expect(mockGmailClient.users.messages.attachments.get).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'draft-msg-1',
        id: 'att-1',
      })

      // Verify the rebuilt message includes the attachment
      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Subject: Updated Subject')
      expect(decoded).toContain('multipart/mixed')
      expect(decoded).toContain('Content-Disposition: attachment; filename="report.pdf"')
      expect(decoded).toContain('application/pdf')
    })

    it('removes attachments when removeAttachments is true', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: {
            id: 'draft-msg-1',
            threadId: 'thread-1',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'With Attachment' },
              ],
              body: {},
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Body text').toString('base64url'),
                  },
                },
                {
                  mimeType: 'application/pdf',
                  filename: 'report.pdf',
                  body: {
                    attachmentId: 'att-1',
                    size: 1000,
                  },
                },
              ],
            },
          },
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await updateDraft('draft-1', { subject: 'No Attachments', removeAttachments: true })

      // Should NOT fetch attachment data
      expect(mockGmailClient.users.messages.attachments.get).not.toHaveBeenCalled()

      // Verify the rebuilt message has no attachment
      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Subject: No Attachments')
      expect(decoded).not.toContain('multipart/mixed')
      expect(decoded).not.toContain('Content-Disposition: attachment')
    })

    it('preserves inline attachment data without separate fetch', async () => {
      const inlineData = Buffer.from('inline content').toString('base64url')

      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: {
            id: 'draft-msg-1',
            threadId: 'thread-1',
            payload: {
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Inline' },
              ],
              body: {},
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Body').toString('base64url'),
                  },
                },
                {
                  mimeType: 'text/csv',
                  filename: 'data.csv',
                  body: {
                    data: inlineData,
                    size: 100,
                  },
                },
              ],
            },
          },
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      await updateDraft('draft-1', { body: 'New body' })

      // Should NOT need to fetch attachment data separately
      expect(mockGmailClient.users.messages.attachments.get).not.toHaveBeenCalled()

      const call = mockGmailClient.users.drafts.update.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Content-Disposition: attachment; filename="data.csv"')
      expect(decoded).toContain('New body')
    })

    it('passes correct params to get and update', async () => {
      mockGmailClient.users.drafts.get.mockResolvedValue({
        data: {
          id: 'draft-42',
          message: createMockMessage({
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Test' },
              ],
              body: {
                data: Buffer.from('Body').toString('base64url'),
              },
            },
          }),
        },
      })

      mockGmailClient.users.drafts.update.mockResolvedValue({
        data: {
          id: 'draft-42',
          message: { id: 'msg-1', threadId: '' },
        },
      })

      await updateDraft('draft-42', { subject: 'New' })

      expect(mockGmailClient.users.drafts.get).toHaveBeenCalledWith({
        userId: 'me',
        id: 'draft-42',
        format: 'FULL',
      })

      expect(mockGmailClient.users.drafts.update).toHaveBeenCalledWith({
        userId: 'me',
        id: 'draft-42',
        requestBody: expect.objectContaining({
          message: expect.objectContaining({
            raw: expect.any(String),
          }),
        }),
      })
    })
  })

  describe('listDrafts', () => {
    it('returns draft summaries', async () => {
      mockGmailClient.users.drafts.list.mockResolvedValue({
        data: {
          drafts: [{ id: 'draft-1' }, { id: 'draft-2' }],
        },
      })

      mockGmailClient.users.drafts.get
        .mockResolvedValueOnce({
          data: {
            id: 'draft-1',
            message: {
              id: 'msg-1',
              snippet: 'First draft...',
              payload: {
                headers: [
                  { name: 'To', value: 'alice@example.com' },
                  { name: 'Subject', value: 'Draft One' },
                ],
              },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: 'draft-2',
            message: {
              id: 'msg-2',
              snippet: 'Second draft...',
              payload: {
                headers: [
                  { name: 'To', value: 'bob@example.com' },
                  { name: 'Subject', value: 'Draft Two' },
                ],
              },
            },
          },
        })

      const result = await listDrafts()

      expect(result).toHaveLength(2)
      expect(result[0].draftId).toBe('draft-1')
      expect(result[0].subject).toBe('Draft One')
      expect(result[0].to).toBe('alice@example.com')
      expect(result[1].draftId).toBe('draft-2')
    })

    it('handles empty draft list', async () => {
      mockGmailClient.users.drafts.list.mockResolvedValue({
        data: { drafts: undefined },
      })

      const result = await listDrafts()
      expect(result).toHaveLength(0)
    })

    it('caps maxResults at 50', async () => {
      mockGmailClient.users.drafts.list.mockResolvedValue({
        data: { drafts: [] },
      })

      await listDrafts(100)

      expect(mockGmailClient.users.drafts.list).toHaveBeenCalledWith({
        userId: 'me',
        maxResults: 50,
      })
    })
  })

  describe('deleteDraft', () => {
    it('deletes the draft', async () => {
      mockGmailClient.users.drafts.delete.mockResolvedValue({})

      await deleteDraft('draft-1')

      expect(mockGmailClient.users.drafts.delete).toHaveBeenCalledWith({
        userId: 'me',
        id: 'draft-1',
      })
    })
  })

  describe('listAttachments', () => {
    it('returns attachments from a message', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'multipart/mixed',
            headers: [],
            body: {},
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('body').toString('base64url') },
              },
              {
                partId: '1',
                mimeType: 'application/pdf',
                filename: 'report.pdf',
                body: { attachmentId: 'att-1', size: 12345 },
              },
              {
                partId: '2',
                mimeType: 'image/png',
                filename: 'screenshot.png',
                body: { attachmentId: 'att-2', size: 67890 },
              },
            ],
          },
        }),
      })

      const result = await listAttachments('msg-1')

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 12345,
        attachmentId: 'att-1',
        partId: '1',
      })
      expect(result[1].filename).toBe('screenshot.png')
    })

    it('returns empty array when no attachments', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage(),
      })

      const result = await listAttachments('msg-1')
      expect(result).toHaveLength(0)
    })

    it('finds attachments in nested multipart', async () => {
      mockGmailClient.users.messages.get.mockResolvedValue({
        data: createMockMessage({
          payload: {
            mimeType: 'multipart/mixed',
            headers: [],
            body: {},
            parts: [
              {
                mimeType: 'multipart/alternative',
                body: {},
                parts: [
                  {
                    mimeType: 'text/plain',
                    body: { data: Buffer.from('text').toString('base64url') },
                  },
                ],
              },
              {
                partId: '1',
                mimeType: 'application/pdf',
                filename: 'nested.pdf',
                body: { attachmentId: 'att-nested', size: 100 },
              },
            ],
          },
        }),
      })

      const result = await listAttachments('msg-1')
      expect(result).toHaveLength(1)
      expect(result[0].filename).toBe('nested.pdf')
    })
  })

  describe('saveAttachment', () => {
    it('downloads and saves attachment to file', async () => {
      const fileContent = 'PDF file content here'
      const base64Data = Buffer.from(fileContent).toString('base64url')

      mockGmailClient.users.messages.attachments.get.mockResolvedValue({
        data: { data: base64Data },
      })

      const savePath = './tmp/test-attachment.pdf'
      const result = await saveAttachment('msg-1', 'att-1', savePath)

      expect(mockGmailClient.users.messages.attachments.get).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-1',
        id: 'att-1',
      })

      expect(result).toContain('test-attachment.pdf')

      // Clean up
      if (fs.existsSync(result)) {
        fs.unlinkSync(result)
      }
    })

    it('throws when attachment data is empty', async () => {
      mockGmailClient.users.messages.attachments.get.mockResolvedValue({
        data: { data: null },
      })

      await expect(saveAttachment('msg-1', 'att-1', './tmp/empty.pdf')).rejects.toThrow(
        'Attachment data is empty',
      )
    })
  })

  describe('createDraft with attachments', () => {
    it('creates a multipart draft when attachments provided', async () => {
      // Create a temp file to attach
      const tmpFile = './tmp/test-attach.txt'
      fs.mkdirSync('./tmp', { recursive: true })
      fs.writeFileSync(tmpFile, 'attachment content')

      mockGmailClient.users.drafts.create.mockResolvedValue({
        data: {
          id: 'draft-1',
          message: { id: 'draft-msg-1', threadId: 'thread-1' },
        },
      })

      const result = await createDraft(
        'bob@example.com',
        'With attachment',
        'See attached',
        undefined,
        undefined,
        [tmpFile],
      )

      expect(result.draftId).toBe('draft-1')

      const call = mockGmailClient.users.drafts.create.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('multipart/mixed')
      expect(decoded).toContain('Content-Disposition: attachment; filename="test-attach.txt"')
      expect(decoded).toContain('See attached')

      // Clean up
      fs.unlinkSync(tmpFile)
    })
  })
})
