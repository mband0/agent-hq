import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch(`${process.env.ATLAS_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3551'}/api/v1/agents/local-mlx/status`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ online: false });
  }
}
