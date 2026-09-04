import { ClientDetail } from '@/components/platform/client-detail';

// Route params are a promise in this version of Next — awaited here so
// the client component receives a plain id.
export default async function PlatformClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ClientDetail accountId={id} />;
}
