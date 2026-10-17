import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { FileOAuthProvider } from './oauth.js';

export interface FoConnectOptions {
  url: string;
  role: string;           // seller | buyer, used for the token file name
  ownerName: string;
  callbackPort: number;
  authDir?: string;
}

/**
 * A connection to one user's Fo MCP server. Fo serves tools/list without auth
 * but requires OAuth for tool calls, so sign-in runs on the first 401.
 */
export class FoConnection {
  private client!: Client;
  private transport!: StreamableHTTPClientTransport;
  private readonly provider: FileOAuthProvider;

  constructor(private readonly opts: FoConnectOptions) {
    this.provider = new FileOAuthProvider(
      `${opts.authDir ?? '.fo-auth'}/${opts.role}.json`,
      opts.callbackPort,
      `ProxyDeal (${opts.ownerName})`,
    );
  }

  async connect(): Promise<this> {
    this.client = new Client({ name: `proxydeal-${this.opts.role}`, version: '0.1.0' });
    this.transport = new StreamableHTTPClientTransport(new URL(this.opts.url), { authProvider: this.provider });
    try {
      await this.client.connect(this.transport);
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await this.signIn();
    }
    return this;
  }

  private async signIn() {
    const code = await this.provider.waitForAuthorizationCode();
    await this.transport.finishAuth(code);
    await this.client.close().catch(() => {});
    this.client = new Client({ name: `proxydeal-${this.opts.role}`, version: '0.1.0' });
    this.transport = new StreamableHTTPClientTransport(new URL(this.opts.url), { authProvider: this.provider });
    await this.client.connect(this.transport);
  }

  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await this.signIn();
      return fn();
    }
  }

  serverVersion() { return this.client.getServerVersion(); }
  listTools() { return this.withAuth(() => this.client.listTools()); }
  callTool(name: string, args: Record<string, unknown>) {
    return this.withAuth(() => this.client.callTool({ name, arguments: args }));
  }
  close() { return this.client.close(); }
}

export function connectFo(opts: FoConnectOptions): Promise<FoConnection> {
  return new FoConnection(opts).connect();
}
