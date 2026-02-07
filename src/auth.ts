import { OAuth2Client } from 'google-auth-library'
import { google, docs_v1, drive_v3, sheets_v4 } from 'googleapis'
import { execSync } from 'child_process'

let cachedToken: string | null = null
let tokenExpiry: number = 0
let docsClient: docs_v1.Docs | null = null
let driveClient: drive_v3.Drive | null = null
let sheetsClient: sheets_v4.Sheets | null = null

function getAccessToken(): string {
  // Cache token for 5 minutes to avoid repeated gcloud calls
  const now = Date.now()
  if (cachedToken && now < tokenExpiry) {
    return cachedToken
  }

  try {
    cachedToken = execSync('gcloud auth print-access-token', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()
    tokenExpiry = now + 5 * 60 * 1000 // 5 minutes
    return cachedToken
  } catch {
    throw new Error('Failed to get access token. Run: gcloud auth login --enable-gdrive-access')
  }
}

function getAuthClient(): OAuth2Client {
  const token = getAccessToken()
  const client = new OAuth2Client()
  client.setCredentials({ access_token: token })
  return client
}

export async function getDocsClient(): Promise<docs_v1.Docs> {
  // Always create fresh client to pick up new token if needed
  const auth = getAuthClient()
  docsClient = google.docs({ version: 'v1', auth })
  return docsClient
}

export async function getDriveClient(): Promise<drive_v3.Drive> {
  const auth = getAuthClient()
  driveClient = google.drive({ version: 'v3', auth })
  return driveClient
}

export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  const auth = getAuthClient()
  sheetsClient = google.sheets({ version: 'v4', auth })
  return sheetsClient
}
