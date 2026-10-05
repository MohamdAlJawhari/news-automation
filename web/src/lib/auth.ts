import "server-only";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),

    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,

    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            prompt: "select_account",
        },
    },

    user: {
        additionalFields: {
            platformRole: {
                type: ["OWNER", "USER"],
                required: false,
                defaultValue: "USER",
                input: false,
            },

            approvalStatus: {
                type: [
                    "PENDING",
                    "APPROVED",
                    "REJECTED",
                    "SUSPENDED",
                ],
                required: false,
                defaultValue: "PENDING",
                input: false,
            },
        },
    },
});