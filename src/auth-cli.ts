#!/usr/bin/env node

/**
 * Interactive OAuth2 setup for gdoc-mcp.
 * Run with: npm run auth
 *
 * Opens a browser for Google OAuth consent. Also prints the URL
 * for SSH/headless environments where you can paste the redirect URL back.
 */

import { OAuth2Client } from 'google-auth-library'
import * as http from 'http'
import * as readline from 'readline'
import { execSync } from 'child_process'
import {
  findClientSecret,
  loadTokens,
  saveTokens,
  SCOPES,
  CONFIG_DIR,
  CLIENT_SECRET_PATHS,
} from './oauth.js'

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not find available port'))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
  })
}

function tryOpenBrowser(url: string): boolean {
  try {
    const platform = process.platform
    if (platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' })
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' })
    } else if (platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore' })
    }
    return true
  } catch {
    return false
  }
}

async function main() {
  // Check for existing tokens
  const existingTokens = loadTokens()
  if (existingTokens?.refresh_token) {
    console.log('Existing tokens found. Re-running will replace them.\n')
  }

  // Find client secret
  const creds = findClientSecret()
  if (!creds) {
    console.error('No client_secret.json found.')
    console.error(`\nLooked in:\n${CLIENT_SECRET_PATHS.map((p) => `  - ${p}`).join('\n')}`)
    console.error('\nTo create one:')
    console.error('1. Go to https://console.cloud.google.com/apis/credentials')
    console.error('2. Create OAuth 2.0 Client ID (Desktop app type)')
    console.error('3. Download JSON and save as:')
    console.error(`   ${CONFIG_DIR}/client_secret.json`)
    process.exit(1)
  }

  const port = await findAvailablePort()
  const redirectUri = `http://localhost:${port}`
  const oauth2Client = new OAuth2Client(creds.client_id, creds.client_secret, redirectUri)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force refresh_token to be issued
  })

  console.log('\n--- Google OAuth Authorization ---\n')
  console.log('Open this URL in your browser:\n')
  console.log(authUrl)
  console.log('')

  const opened = tryOpenBrowser(authUrl)
  if (opened) {
    console.log('Browser opened. Waiting for authorization...')
  } else {
    console.log('Could not open browser automatically.')
    console.log('Please visit the URL above manually.')
  }

  console.log(
    "\nIf the redirect fails (e.g. SSH), copy the URL from your browser's address bar and paste it here:\n",
  )

  // Race between localhost callback and manual paste
  const code = await new Promise<string>((resolve, reject) => {
    let resolved = false

    // Start callback server
    const callbackServer = http.createServer((req, res) => {
      if (resolved) return

      const url = new URL(req.url!, `http://localhost:${port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`)
        if (!resolved) {
          resolved = true
          reject(new Error(`Authorization failed: ${error}`))
        }
        callbackServer.close()
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          '<h1>Authorization successful!</h1><p>You can close this tab and return to your terminal.</p>',
        )
        if (!resolved) {
          resolved = true
          resolve(code)
        }
        callbackServer.close()
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing code parameter')
    })

    callbackServer.listen(port)

    // Also accept manual input (for SSH)
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.on('line', (line) => {
        if (resolved) return
        const trimmed = line.trim()
        if (!trimmed) return

        // Try parsing as a URL with ?code= parameter
        try {
          const url = new URL(trimmed)
          const codeParam = url.searchParams.get('code')
          if (codeParam) {
            resolved = true
            resolve(codeParam)
            callbackServer.close()
            rl.close()
            return
          }
        } catch {
          // Not a URL
        }

        // Accept raw code (long alphanumeric string)
        if (trimmed.length > 10 && !trimmed.includes(' ')) {
          resolved = true
          resolve(trimmed)
          callbackServer.close()
          rl.close()
        }
      })
    }

    // Timeout after 5 minutes
    setTimeout(
      () => {
        if (!resolved) {
          resolved = true
          reject(new Error('Authorization timed out after 5 minutes'))
          callbackServer.close()
        }
      },
      5 * 60 * 1000,
    )
  })

  // Exchange code for tokens
  console.log('\nExchanging authorization code for tokens...')
  const { tokens } = await oauth2Client.getToken(code)

  saveTokens(tokens)

  console.log('\nAuthorization successful!')
  console.log(`Tokens saved to: ${CONFIG_DIR}/tokens.json`)

  if (tokens.refresh_token) {
    console.log('Refresh token obtained. Access will auto-renew until you revoke it.')
  }

  console.log('\nScopes granted:')
  SCOPES.forEach((s) => console.log(`  - ${s.split('/').pop()}`))

  console.log('\nYou can now use all gdoc-mcp tools including Google Calendar.')
  console.log('If running as an MCP server, restart it to pick up the new credentials.')
}

main().catch((err) => {
  console.error('\nError:', err.message)
  process.exit(1)
})
