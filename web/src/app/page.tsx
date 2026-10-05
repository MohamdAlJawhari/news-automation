import { redirect } from "next/navigation";
import { getCurrentAccess, getEntryDestination } from "@/lib/access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function EntryPage() {
  redirect(getEntryDestination(await getCurrentAccess()));
}
