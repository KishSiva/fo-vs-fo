import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/**
 * File-backed OAuth provider for a headless proxy. Each proxy (Alice, Bob)
 * signs in to its own Wajo account once; tokens live in .fo-auth/<role>.json.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private data: Stored;
  private pendingAuthUrl?: URL;

  constructor(
    private readonly path: string,
    private readonly callbackPort: number,
    private readonly clientName: string,
  ) {
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  private persist() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get redirectUrl() {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp',
    };
  }

  clientInformation() { return this.data.client; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.data.client = info; this.persist(); }
  tokens() { return this.data.tokens; }
  saveTokens(tokens: OAuthTokens) { this.data.tokens = tokens; this.persist(); }
  saveCodeVerifier(v: string) { this.data.verifier = v; this.persist(); }
  codeVerifier() {
    if (!this.data.verifier) throw new Error('No PKCE code verifier saved');
    return this.data.verifier;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.data.client;
    if (scope === 'all' || scope === 'tokens') delete this.data.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.data.verifier;
    this.persist();
  }

  redirectToAuthorization(url: URL) {
    this.pendingAuthUrl = url;
  }

  /** Called after connect() throws UnauthorizedError: prints the sign-in URL and waits for the code. */
  async waitForAuthorizationCode(timeoutMs = 5 * 60_000): Promise<string> {
    const url = this.pendingAuthUrl;
    if (!url) throw new Error('Fo did not request authorization');
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', this.redirectUrl);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(code ? '<h3>Signed in to Fo. You can close this tab.</h3>' : `<h3>Sign-in failed: ${err}</h3>`);
        clearTimeout(timer);
        server.close();
        code ? resolve(code) : reject(new Error(`OAuth error: ${err}`));
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('Timed out waiting for Fo sign-in')); }, timeoutMs);
      server.listen(this.callbackPort, () => {
        console.log(`\nSign in to Fo (${this.clientName}) by opening:\n\n  ${url.toString()}\n`);
      });
    });
  }
}
