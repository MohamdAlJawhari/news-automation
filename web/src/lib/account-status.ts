import type { CurrentAccess } from "@/lib/access";
export function getAccountStatus(user: CurrentAccess["user"]) {
  if (!user.emailVerified)
    return {
      title: "Verified email required",
      message:
        "A verified email address is required to use the platform. Contact the platform owner for assistance.",
    };
  switch (user.approvalStatus) {
    case "PENDING":
      return {
        title: "Waiting for approval",
        message:
          "Your account is waiting for the platform owner's approval. Check again after your access has been reviewed.",
      };
    case "REJECTED":
      return {
        title: "Registration not approved",
        message:
          "Your registration was not approved. Contact the platform owner if you believe this is a mistake.",
      };
    case "SUSPENDED":
      return {
        title: "Account suspended",
        message:
          "Your access is suspended. Contact the platform owner for assistance.",
      };
  }
  if (!user.workspace)
    return {
      title: "Workspace unavailable",
      message:
        "Your account is approved, but no workspace is available. Contact the platform owner to restore access.",
    };
  return {
    title: "No services enabled",
    message:
      "Your account is approved, but no services are enabled for your workspace. Contact the platform owner to request access.",
  };
}
