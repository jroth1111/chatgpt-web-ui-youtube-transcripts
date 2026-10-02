declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    OWNER_EMAIL?: string;
    MCP_AUTH_KEY?: string;
    BUCKET?: R2Bucket;
  }
}
