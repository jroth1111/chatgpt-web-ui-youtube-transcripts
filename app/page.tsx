import { requireChatGPTUser } from './chatgpt-auth';
import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { authorize } from '@/lib/transcript-service.mjs';
export const dynamic = 'force-dynamic';
export default async function Home() {
  await requireChatGPTUser('/');
  authorize(await headers(),env.OWNER_EMAIL);
  return <main className="verification-shell">
    <div className="caption-mark" aria-hidden="true">CC</div>
    <p className="eyebrow">Private workspace</p>
    <h1>YouTube Transcripts</h1>
    <section className="verification-notice" aria-labelledby="verification-title">
      <h2 id="verification-title">Retrieval verification pending</h2>
      <p>The transcript viewer will be enabled after this deployment returns real captions and passes the live MCP checks.</p>
      <p>Available captions only. Usage and video coverage depend on YouTube and hosting limits.</p>
    </section>
  </main>;
}
