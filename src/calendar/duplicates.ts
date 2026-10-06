import type { EventInfo } from './client.js'
import { eventTimeRange, formatEventWhen } from './format.js'

// Simple heuristic for spotting the same real-world event entered on several calendars:
// overlapping time + similar normalized title, on different calendars.

const FILLER_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'at', 'for', 'with', 'to', 'on', 'in'])

export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !FILLER_WORDS.has(t) && !/^\d+$/.test(t))
}

// Overlap coefficient: shared tokens / size of the smaller token set
export function titlesSimilar(a: string, b: string, threshold = 0.6): boolean {
  const ta = new Set(normalizeTitle(a))
  const tb = new Set(normalizeTitle(b))
  if (ta.size === 0 || tb.size === 0) return false
  const shared = [...ta].filter((t) => tb.has(t)).length
  return shared / Math.min(ta.size, tb.size) >= threshold
}

function overlaps(a: EventInfo, b: EventInfo): boolean {
  const ra = eventTimeRange(a)
  const rb = eventTimeRange(b)
  return ra.start < rb.end && rb.start < ra.end
}

export function findDuplicateGroups(events: EventInfo[]): EventInfo[][] {
  // Union-find over matching pairs so chains (A~B, B~C) form one group
  const parent = events.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i]
      const b = events[j]
      if (a.calendarId === b.calendarId) continue
      if (overlaps(a, b) && titlesSimilar(a.summary, b.summary)) parent[find(j)] = find(i)
    }
  }

  const groups = new Map<number, EventInfo[]>()
  events.forEach((e, i) => {
    const root = find(i)
    groups.set(root, [...(groups.get(root) || []), e])
  })
  return [...groups.values()].filter((g) => g.length > 1)
}

export function formatDuplicates(groups: EventInfo[][]): string {
  if (groups.length === 0) return 'Possible duplicates: none found'
  const lines = ['Possible duplicates:']
  groups.forEach((group, i) => {
    group.forEach((e, j) => {
      const prefix = j === 0 ? `${i + 1}. ` : ' '.repeat(`${i + 1}. `.length)
      const cal = e.calendarName || e.calendarId || '?'
      lines.push(`${prefix}"${e.summary}" (${cal}, ${formatEventWhen(e)}, ID: ${e.id})`)
    })
  })
  return lines.join('\n')
}
