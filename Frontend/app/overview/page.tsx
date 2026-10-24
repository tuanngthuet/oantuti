import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import Navbar from "@/components/Navbar";
import CompetitionOverview from "@/components/CompetitionOverview";

export const metadata: Metadata = {
  title: "Tổng quan giải đấu | OTTv2 Arena",
  description: "Tổng quan, luật thi đấu, hướng dẫn nộp bot và thể thức giải cờ Oẳn Tù Tì v2",
};

export const runtime = "nodejs";

export default async function OverviewPage() {
  const session = await getSession();

  return (
    <div className="min-h-screen bg-[#F5F0ED] text-[#1a1e29]">
      <Navbar initialUser={session} />
      <main>
        <CompetitionOverview />
      </main>
    </div>
  );
}
