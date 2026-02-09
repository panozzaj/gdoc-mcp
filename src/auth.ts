import { google, docs_v1, drive_v3, sheets_v4, calendar_v3, gmail_v1 } from 'googleapis'
import { getOAuth2Client, OAUTH_SETUP_HELP, REAUTH_HELP } from './oauth.js'

export async function getDocsClient(): Promise<docs_v1.Docs> {
  const auth = await getAuth()
  return google.docs({ version: 'v1', auth })
}

export async function getDriveClient(): Promise<drive_v3.Drive> {
  const auth = await getAuth()
  return google.drive({ version: 'v3', auth })
}

export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  const auth = await getAuth()
  return google.sheets({ version: 'v4', auth })
}

export async function getCalendarClient(): Promise<calendar_v3.Calendar> {
  const auth = await getAuth()
  return google.calendar({ version: 'v3', auth })
}

export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  const auth = await getAuth()
  return google.gmail({ version: 'v1', auth })
}

async function getAuth() {
  const client = await getOAuth2Client()
  if (!client) {
    const hasTokens = (await import('./oauth.js')).loadTokens()
    if (hasTokens) {
      throw new Error(REAUTH_HELP)
    }
    throw new Error(OAUTH_SETUP_HELP)
  }
  return client
}
