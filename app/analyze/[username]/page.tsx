import { GitInsightDashboard } from "../../_components/gitinsight-experience";

type AnalysisPageProps = {
  params: Promise<{
    username: string;
  }>;
};

export default async function AnalysisPage({ params }: AnalysisPageProps) {
  const { username } = await params;

  return <GitInsightDashboard initialUsername={username} />;
}