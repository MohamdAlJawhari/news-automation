"use client";
import { useFormStatus } from "react-dom";
export default function SubmitButton({
  children,
  pendingLabel = "Saving…",
  className = "button primary",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}
