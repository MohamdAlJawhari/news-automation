import { redirect } from "next/navigation";
import { getCurrentAccess, getEntryDestination } from "@/lib/access";
import LoginForm from "@/components/LoginForm";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function LoginPage() {
  const access = await getCurrentAccess();
  if (access) redirect(getEntryDestination(access));
  return <LoginForm />;
}
