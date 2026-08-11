import { PublicSharePage } from "../share-page";

export default async function SharedItemRoute({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PublicSharePage token={token} />;
}
