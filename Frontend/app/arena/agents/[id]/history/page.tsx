import { Suspense } from 'react';
import GameHistory from '@/components/GameHistory';
export default async function AgentHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<p className="p-8">Đang tải lịch sử…</p>}><GameHistory agentId={id} /></Suspense>;
}
