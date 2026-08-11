import type { NextResponse } from 'next/server';
import { api } from '@/lib/api';
import { runAction } from '@/lib/route-handler';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return runAction(() => api.approve(id));
}
