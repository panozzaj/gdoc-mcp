/**
 * Simple diff utility for showing changes in a readable format.
 * Uses word-level diff for short text, line-level for longer text.
 * Outputs ANSI-colored diff that renders in Claude Code.
 */

// Number of context lines to show around changes
const CONTEXT_LINES = 1;

// ANSI escape codes for colored diff output
const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  // Removed line colors (red)
  removedFg: '\x1b[38;5;167m',
  removedBg: '\x1b[48;5;52m',
  // Added line colors (green)
  addedFg: '\x1b[38;5;77m',
  addedBg: '\x1b[48;5;22m',
  // Text color
  white: '\x1b[38;5;231m',
  // Context line color (dim)
  context: '\x1b[38;5;245m',
  // Reset colors
  resetFg: '\x1b[39m',
  resetBg: '\x1b[49m',
};

interface DiffResult {
  /** Formatted diff string for display */
  formatted: string;
  /** Whether there were actual changes */
  hasChanges: boolean;
}

/**
 * Generate a readable diff between old and new text.
 * For short text (single line), shows word-level changes.
 * For longer text, shows line-level diff.
 */
export function generateDiff(oldText: string, newText: string): DiffResult {
  if (oldText === newText) {
    return { formatted: '(no changes)', hasChanges: false };
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Single line: use inline diff
  if (oldLines.length === 1 && newLines.length === 1) {
    return {
      formatted: formatInlineDiff(oldText, newText),
      hasChanges: true,
    };
  }

  // Multi-line: use line-by-line diff
  return {
    formatted: formatLineDiff(oldLines, newLines),
    hasChanges: true,
  };
}

/**
 * Format a single-line change showing both old and new with word-level highlighting.
 * Shows the full line with changed words highlighted.
 */
function formatInlineDiff(oldText: string, newText: string): string {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);

  // Find common prefix
  let prefixEnd = 0;
  while (
    prefixEnd < oldWords.length &&
    prefixEnd < newWords.length &&
    oldWords[prefixEnd] === newWords[prefixEnd]
  ) {
    prefixEnd++;
  }

  // Find common suffix
  let oldSuffixStart = oldWords.length;
  let newSuffixStart = newWords.length;
  while (
    oldSuffixStart > prefixEnd &&
    newSuffixStart > prefixEnd &&
    oldWords[oldSuffixStart - 1] === newWords[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  const prefix = oldWords.slice(0, prefixEnd).join('');
  const oldMiddle = oldWords.slice(prefixEnd, oldSuffixStart).join('');
  const newMiddle = newWords.slice(prefixEnd, newSuffixStart).join('');
  const suffix = oldWords.slice(oldSuffixStart).join('');

  // Build two-line diff: - old / + new with word-level highlighting
  const lines: string[] = [];

  // Old line with removed words highlighted
  if (oldMiddle || !newMiddle) {
    let oldLine = prefix;
    if (oldMiddle) {
      oldLine += `${ANSI.removedFg}${ANSI.removedBg}${oldMiddle}${ANSI.resetFg}${ANSI.resetBg}`;
    }
    oldLine += suffix;
    lines.push(formatRemovedLine(oldLine));
  }

  // New line with added words highlighted
  let newLine = prefix;
  if (newMiddle) {
    newLine += `${ANSI.addedFg}${ANSI.addedBg}${newMiddle}${ANSI.resetFg}${ANSI.resetBg}`;
  }
  newLine += suffix;
  lines.push(formatAddedLine(newLine));

  return lines.join('\n');
}

/**
 * Format a removed line with ANSI colors.
 */
function formatRemovedLine(line: string): string {
  return `${ANSI.removedFg}${ANSI.removedBg}- ${ANSI.white}${line}${ANSI.resetFg}${ANSI.resetBg}`;
}

/**
 * Format an added line with ANSI colors.
 */
function formatAddedLine(line: string): string {
  return `${ANSI.addedFg}${ANSI.addedBg}+ ${ANSI.white}${line}${ANSI.resetFg}${ANSI.resetBg}`;
}

/**
 * Format a context line (unchanged) with dim styling.
 */
function formatContextLine(line: string): string {
  return `${ANSI.context}  ${line}${ANSI.reset}`;
}

/**
 * Format multi-line changes with ANSI colors.
 * Shows context lines around changes for readability.
 */
function formatLineDiff(oldLines: string[], newLines: string[]): string {
  // Build list of changes with their positions
  const changes: Array<{
    type: 'remove' | 'add' | 'context';
    line: string;
    oldIdx?: number;
    newIdx?: number;
  }> = [];

  const lcs = computeLCS(oldLines, newLines);
  let oldIdx = 0;
  let newIdx = 0;

  for (const common of lcs) {
    // Mark removed lines
    while (oldIdx < common.oldIndex) {
      changes.push({ type: 'remove', line: oldLines[oldIdx], oldIdx });
      oldIdx++;
    }
    // Mark added lines
    while (newIdx < common.newIndex) {
      changes.push({ type: 'add', line: newLines[newIdx], newIdx });
      newIdx++;
    }
    // Mark context line
    changes.push({ type: 'context', line: newLines[newIdx], oldIdx, newIdx });
    oldIdx++;
    newIdx++;
  }

  // Remaining removed lines
  while (oldIdx < oldLines.length) {
    changes.push({ type: 'remove', line: oldLines[oldIdx], oldIdx });
    oldIdx++;
  }
  // Remaining added lines
  while (newIdx < newLines.length) {
    changes.push({ type: 'add', line: newLines[newIdx], newIdx });
    newIdx++;
  }

  // Determine which context lines to show (within CONTEXT_LINES of a change)
  const showLine = new Set<number>();
  for (let i = 0; i < changes.length; i++) {
    if (changes[i].type !== 'context') {
      // Mark surrounding context lines to show
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(changes.length - 1, i + CONTEXT_LINES); j++) {
        showLine.add(j);
      }
    }
  }

  // Build output with separators for gaps
  const result: string[] = [];
  let lastShown = -1;

  for (let i = 0; i < changes.length; i++) {
    if (!showLine.has(i)) continue;

    // Add separator if there's a gap in shown lines
    if (lastShown >= 0 && i > lastShown + 1) {
      result.push(`${ANSI.dim}...${ANSI.reset}`);
    }

    const change = changes[i];
    if (change.type === 'remove') {
      result.push(formatRemovedLine(change.line));
    } else if (change.type === 'add') {
      result.push(formatAddedLine(change.line));
    } else {
      result.push(formatContextLine(change.line));
    }

    lastShown = i;
  }

  return result.join('\n');
}

interface LCSItem {
  oldIndex: number;
  newIndex: number;
}

/**
 * Compute longest common subsequence of lines.
 */
function computeLCS(oldLines: string[], newLines: string[]): LCSItem[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const result: LCSItem[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
