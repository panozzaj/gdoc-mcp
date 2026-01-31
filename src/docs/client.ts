import { getDocsClient, getDriveClient } from '../auth.js';
import { convertToMarkdown, findTextRange } from './converter.js';
import {
  getCachedRevision,
  setCachedRevision,
  NotReadError,
} from './concurrency.js';
import { extractDocId } from '../types.js';

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

  // 3. Find the text to replace (fails if text no longer exists)
  const range = findTextRange(doc, oldText);
  if (!range) {
    throw new Error(
      `Text not found in document: "${oldText.slice(0, 100)}${oldText.length > 100 ? '...' : ''}"\n` +
      `The document may have been modified. Try reading it again.`
    );
  }

  // 4. Apply the edit (delete then insert)
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
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
            text: newText,
          },
        },
      ],
    },
  });

  // 5. Update the cached revision
  const updated = await docs.documents.get({ documentId: docId });
  const newRevision = updated.data.revisionId || '';
  setCachedRevision(docId, newRevision);

  return {
    success: true,
    message: `Replaced "${oldText.slice(0, 50)}..." with "${newText.slice(0, 50)}..."`,
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
