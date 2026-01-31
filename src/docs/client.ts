import { getDocsClient, getDriveClient } from '../auth.js';
import { convertToMarkdown, findTextRange } from './converter.js';
import {
  getCachedRevision,
  setCachedRevision,
  NotReadError,
} from './concurrency.js';
import { extractDocId } from '../types.js';
import {
  parseMarkdown,
  hasMarkdownFormatting,
  buildFormattingRequests,
} from './markdown.js';

export interface DocInfo {
  id: string;
  title: string;
  revisionId: string;
}

export interface DocContent {
  id: string;
  title: string;
  content: string;
  revisionId: string;
}

export async function readDoc(
  docIdOrUrl: string,
  format: 'markdown' | 'json' = 'markdown'
): Promise<DocContent> {
  const docId = extractDocId(docIdOrUrl);
  const docs = await getDocsClient();

  const response = await docs.documents.get({ documentId: docId });
  const doc = response.data;

  const revisionId = doc.revisionId || '';
  setCachedRevision(docId, revisionId);

  let content: string;
  if (format === 'json') {
    content = JSON.stringify(doc, null, 2);
  } else {
    content = convertToMarkdown(doc);
  }

  return {
    id: docId,
    title: doc.title || 'Untitled',
    content,
    revisionId,
  };
}

export async function editDoc(
  docIdOrUrl: string,
  oldText: string,
  newText: string
): Promise<{ success: boolean; message: string }> {
  const docId = extractDocId(docIdOrUrl);
  const docs = await getDocsClient();

  // 1. Check if we've read this doc before (for discoverability, not locking)
  const cachedRevision = getCachedRevision(docId);
  if (!cachedRevision) {
    throw new NotReadError(docId);
  }

  // 2. Fetch current doc (may have changed since read - that's OK)
  const response = await docs.documents.get({ documentId: docId });
  const doc = response.data;

  // 3. Parse markdown from old_text to get raw text for matching
  const parsedOld = parseMarkdown(oldText);
  const searchText = parsedOld.rawText;

  // 4. Find the text to replace (fails if text no longer exists or is ambiguous)
  const range = findTextRange(doc, searchText);
  if (!range) {
    const displayText = hasMarkdownFormatting(oldText) ? `${oldText} (raw: "${searchText}")` : oldText;
    throw new Error(
      `Text not found in document: "${displayText.slice(0, 100)}${displayText.length > 100 ? '...' : ''}"\n` +
      `The document may have been modified. Try reading it again.`
    );
  }

  if (range.matchCount > 1) {
    throw new Error(
      `Text appears ${range.matchCount} times in document: "${searchText.slice(0, 50)}${searchText.length > 50 ? '...' : ''}"\n` +
      `Provide more surrounding context to make the match unique.`
    );
  }

  // 5. Parse markdown from new_text to get raw text and formatting
  const parsedNew = parseMarkdown(newText);

  // 6. Build requests: delete old, insert new text, then apply formatting
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
  ];

  // 7. Add formatting requests for each segment
  let currentIndex = range.startIndex;
  for (const segment of parsedNew.segments) {
    const segmentEnd = currentIndex + segment.text.length;
    const formatRequests = buildFormattingRequests(
      currentIndex,
      segmentEnd,
      segment.formatting
    );
    requests.push(...formatRequests);
    currentIndex = segmentEnd;
  }

  // 8. Apply all changes in one batch
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });

  // 9. Update the cached revision
  const updated = await docs.documents.get({ documentId: docId });
  const newRevision = updated.data.revisionId || '';
  setCachedRevision(docId, newRevision);

  return {
    success: true,
    message: `Replaced "${oldText.slice(0, 50)}${oldText.length > 50 ? '...' : ''}" with "${newText.slice(0, 50)}${newText.length > 50 ? '...' : ''}"`,
  };
}

export async function getDocInfo(docIdOrUrl: string): Promise<DocInfo> {
  const docId = extractDocId(docIdOrUrl);
  const docs = await getDocsClient();

  const response = await docs.documents.get({ documentId: docId });
  const doc = response.data;

  return {
    id: docId,
    title: doc.title || 'Untitled',
    revisionId: doc.revisionId || '',
  };
}

export async function listDocs(
  query?: string,
  limit: number = 10
): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  const drive = await getDriveClient();

  let q = "mimeType='application/vnd.google-apps.document'";
  if (query) {
    q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
  }

  const response = await drive.files.list({
    q,
    pageSize: limit,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, modifiedTime)',
  });

  return (response.data.files || []).map(f => ({
    id: f.id || '',
    name: f.name || 'Untitled',
    modifiedTime: f.modifiedTime || '',
  }));
}
