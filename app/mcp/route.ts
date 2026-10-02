import { env } from 'cloudflare:workers';
import { handleMcp } from '@/lib/mcp-handler.mjs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) { return handleMcp(request, env); }
export function GET(request: Request) { return handleMcp(request, env); }
export function DELETE(request: Request) { return handleMcp(request, env); }
