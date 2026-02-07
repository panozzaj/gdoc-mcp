import { z } from 'zod'

// Tool parameter schemas
export const DocIdSchema = z.object({
  docId: z.string().describe('Google Doc ID or URL'),
})

export const DocReadSchema = DocIdSchema.extend({
  format: z.enum(['markdown', 'json']).optional().default('markdown').describe('Output format'),
})

export const DocEditSchema = DocIdSchema.extend({
  old_text: z.string().describe('Text to find and replace'),
  new_text: z.string().describe('Replacement text'),
})

export const DocListSchema = z.object({
  query: z.string().optional().describe('Search query'),
  limit: z.number().optional().default(10).describe('Max results'),
})

// Helper to extract doc ID from URL or raw ID
export function extractDocId(input: string): string {
  // Handle full URLs like https://docs.google.com/document/d/DOC_ID/edit
  const urlMatch = input.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
  if (urlMatch) {
    return urlMatch[1]
  }
  // Assume it's already a doc ID
  return input
}

// Helper to extract folder ID from URL or raw ID
export function extractFolderId(input: string): string {
  // Handle full URLs like https://drive.google.com/drive/folders/FOLDER_ID
  const urlMatch = input.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  if (urlMatch) {
    return urlMatch[1]
  }
  return input
}
