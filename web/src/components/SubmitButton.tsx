"use client";
import { useFormStatus } from "react-dom";
export default function SubmitButton({
  children,
  disabled = false,
  pendingLabel = "Saving…",
  className = "button primary",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending || disabled} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}
