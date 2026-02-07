// In-memory revision cache for optimistic concurrency control
const revisionCache = new Map<string, string>()

export function getCachedRevision(docId: string): string | undefined {
  return revisionCache.get(docId)
}

export function setCachedRevision(docId: string, revisionId: string): void {
  revisionCache.set(docId, revisionId)
}

export function clearCachedRevision(docId: string): void {
  revisionCache.delete(docId)
}

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrencyError'
  }
}

export class NotReadError extends Error {
  constructor(docId: string) {
    super(`Must read document before editing. Use gdoc_read first. (docId: ${docId})`)
    this.name = 'NotReadError'
  }
}
