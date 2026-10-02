import { env } from 'cloudflare:workers';
import { handleAcquisition } from '@/lib/acquisition-handler.mjs';
export const dynamic = 'force-dynamic';
export function POST(request: Request) { return handleAcquisition(request, env); }
