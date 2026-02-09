import { OAuth2Client, Credentials } from 'google-auth-library'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'gdoc-mcp')
export const TOKENS_PATH = path.join(CONFIG_DIR, 'tokens.json')

export const CLIENT_SECRET_PATHS = [
  path.join(CONFIG_DIR, 'client_secret.json'),
  path.join(process.cwd(), 'client_secret.json'),
]

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
]

let cachedOAuth2Client: OAuth2Client | null = null
let oauthAvailable: boolean | null = null

export function findClientSecret(): { client_id: string; client_secret: string } | null {
  for (const p of CLIENT_SECRET_PATHS) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
        const creds = data.installed || data.web
        if (creds?.client_id && creds?.client_secret) {
          return { client_id: creds.client_id, client_secret: creds.client_secret }
        }
      } catch {
        continue
      }
    }
  }
  return null
}

export function loadTokens(): Credentials | null {
  if (!fs.existsSync(TOKENS_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'))
  } catch {
    return null
  }
}

export function saveTokens(tokens: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  // Merge with existing to preserve refresh_token across refreshes
  const existing = loadTokens()
  const merged = { ...existing, ...tokens }
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged, null, 2))
}

export async function getOAuth2Client(): Promise<OAuth2Client | null> {
  // Quick check: if we've already determined OAuth is not available this session
  if (oauthAvailable === false) return null

  const creds = findClientSecret()
  if (!creds) {
    oauthAvailable = false
    return null
  }

  const tokens = loadTokens()
  if (!tokens || !tokens.refresh_token) {
    oauthAvailable = false
    return null
  }

  // Return cached client if token is still fresh (>1min remaining)
  if (cachedOAuth2Client) {
    const credentials = cachedOAuth2Client.credentials
    if (credentials.expiry_date && credentials.expiry_date > Date.now() + 60_000) {
      return cachedOAuth2Client
    }
  }

  const oauth2Client = new OAuth2Client(creds.client_id, creds.client_secret)
  oauth2Client.setCredentials(tokens)

  // Refresh if expired or about to expire
  if (!tokens.expiry_date || tokens.expiry_date < Date.now() + 60_000) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken()
      saveTokens(credentials)
      oauth2Client.setCredentials({ ...tokens, ...credentials })
    } catch {
      // Refresh failed - tokens may be revoked
      oauthAvailable = false
      return null
    }
  }

  cachedOAuth2Client = oauth2Client
  oauthAvailable = true
  return oauth2Client
}

export const OAUTH_SETUP_HELP =
  'To set up OAuth (required for Calendar, recommended for all APIs):\n' +
  '1. Create an OAuth 2.0 Client ID at https://console.cloud.google.com/apis/credentials\n' +
  '   (Application type: Desktop app)\n' +
  '2. Download the JSON and save as ~/.config/gdoc-mcp/client_secret.json\n' +
  '3. Run: npm run auth'

export const REAUTH_HELP = 'Your OAuth tokens have expired or been revoked.\n' + 'Run: npm run auth'
