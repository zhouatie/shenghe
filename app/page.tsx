import { getAppState } from "@/lib/db";
import Dashboard from "@/app/components/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page() {
  const initialState = await getAppState();
  return <Dashboard initialState={initialState} />;
}
