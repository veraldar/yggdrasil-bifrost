/** POST /api/session/[id]/abort → abort a running opencode generation. */

import { NextResponse } from 'next/server';
import { ocFetch, resolveId } from '@/lib/oc';

export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id);
    await ocFetch(`/session/${sid}/abort`, { method: 'POST' });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
