import ReplayView from "@/components/ReplayView";

export default async function RatingReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ReplayView
      apiUrl={`/api/rating/matches/${id}/replay`}
      backLink="/arena/leaderboard"
      backLabel="← Leaderboard"
    />
  );
}
