import ReplayView from "@/components/ReplayView";

export default async function FriendlyReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ReplayView
      apiUrl={`/api/friendly/${id}/replay`}
      backLink="/arena/friendly"
      backLabel="← Thách đấu riêng tư"
    />
  );
}
