/**
 * GET  /api/session/[id]/messages → transcript for one session
 * POST /api/session/[id]/prompt   → send text/images/files to the session
 */

import { NextResponse } from 'next/server';
import { bustCache } from '@/lib/oc-cache';
import { ocFetch, resolveId } from '@/lib/oc';

export const dynamic = 'force-dynamic';


export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id);
    const msgs = await ocFetch(`/session/${sid}/message`);
    const out = msgs.map((m: any) => {
      const text = (m.parts || [])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text || '')
        .join('\n')
        .trim();
      // tool-only steps must stay visible on the phone ("thinking then
      // nothing" bug): one compact line of tool activity, no part details
      const tools = (m.parts || [])
        .filter((p: any) => p.type === 'tool' && p.state?.title)
        .map((p: any) => String(p.state.title).slice(0, 40));
      return {
        role: m.info?.role || m.role,
        text:
          text ||
          (tools.length
            ? `⚙ ${tools.slice(0, 3).join(' · ')}${tools.length > 3 ? ` +${tools.length - 3}` : ''}`
            : ''),
        images: (m.parts || [])
          .filter((p: any) => p.type === 'image' || p.mime?.startsWith('image/'))
          .map((p: any) => p.url || p.data || null),
        time: m.info?.time?.created || 0,
      };
    });
    const all = out.filter((m: any) => m.text || m.images.length);
    // run state for the busy indicator: opencode emits one assistant message
    // per step, so "an assistant message landed" ≠ "the run is done". The run
    // is done only when the LAST raw message is an assistant message with
    // time.completed set (0 while a step is in progress or the last message
    // is the user's). State string lets the client detect "unchanged since
    // last poll" without trusting wall clocks.
    const lastRaw = msgs[msgs.length - 1];
    const lastRole = lastRaw?.info?.role || lastRaw?.role || '';
    const lastDone = lastRole === 'assistant' ? lastRaw?.info?.time?.completed || 0 : 0;
    const runState = `${lastRaw?.info?.id || lastRaw?.id || 'none'}|${lastDone}`;
    // long sessions: default to the latest window, older pages load on demand
    const limit = Number(new URL(req.url).searchParams.get('limit') || 0);
    const body = limit > 0 ? all.slice(-limit) : all;
    return NextResponse.json(body, {
      headers: {
        'X-Total-Count': String(all.length),
        'X-Run-State': runState,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const sid = await resolveId(id);
    const body = await req.json();
    const async = body.async === true;
    const parts: any[] = [];
    const text = String(body.text || '').trim();
    if (text) parts.push({ type: 'text', text });

    for (const dataUrl of body.images || []) {
      // opencode accepts attachments as file parts with a data: url
      // ({type:'image'} is rejected with 400 — verified against the live server)
      const mime = /^data:([^;,]+)/.exec(String(dataUrl))?.[1] || 'image/png';
      parts.push({ type: 'file', mime, url: dataUrl });
    }
    for (const f of body.files || []) {
      // md/txt/html arrive as fenced content so the model sees them verbatim
      parts.push({
        type: 'text',
        text: `\n\n--- attached file: ${f.name} ---\n\`\`\`\n${String(f.content).slice(0, 200_000)}\n\`\`\``,
      });
    }
    if (!parts.length) return NextResponse.json({ error: 'empty' }, { status: 400 });

    if (async) {
      // fire-and-forget: reply lands via transcript polling
      const t0 = Date.now();
      ocFetch(`/session/${sid}/message`, {
        method: 'POST',
        body: JSON.stringify({ parts }),
      })
        .then(() => console.log(`[oc] async prompt done ${Date.now() - t0}ms`))
        .catch((e) => console.error(`[oc] async prompt failed: ${e}`));
      bustCache();
      return NextResponse.json({ queued: true });
    }

    const reply = await ocFetch(`/session/${sid}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts }),
    });
    bustCache();
    const out = (reply.parts || [])
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('\n')
      .trim();
    return NextResponse.json({ text: out });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
