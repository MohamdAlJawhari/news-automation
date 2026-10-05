import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

import {
    processRssContent,
    readReplacementRules,
} from "@/lib/rss-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
};

// Remove characters XML 1.0 cannot represent, then escape XML markup.
function escapeXml(value: string): string {
    return value
        .replace(
            /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,
            ""
        )
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function safeSourceUrl(value: string | null): string | null {
    if (!value) return null;

    try {
        const url = new URL(value);

        if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
        ) {
            return null;
        }

        return url.href;
    } catch {
        return null;
    }
}

function unavailable() {
    return new Response("Feed unavailable.", {
        status: 404,
        headers: responseHeaders,
    });
}

export async function GET(
    _request: Request,
    context: { params: Promise<{ token: string }> }
) {
    const { token } = await context.params;

    if (!/^[a-f0-9]{64}$/.test(token)) {
        return unavailable();
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");

    try {
        const feed = await prisma.rssFeed.findUnique({
            where: { tokenHash },
            select: {
                enabled: true,
                title: true,
                description: true,
                headerText: true,
                footerText: true,
                removeKeywords: true,
                replaceRules: true,
                workspace: {
                    select: {
                        rssEnabled: true,
                        owner: {
                            select: {
                                emailVerified: true,
                                approvalStatus: true,
                            },
                        },
                    },
                },
                items: {
                    where: { visible: true },
                    orderBy: [
                        { publishedAt: "desc" },
                        { id: "desc" },
                    ],
                    take: 50,
                    select: {
                        id: true,
                        title: true,
                        content: true,
                        sourceUrl: true,
                        publishedAt: true,
                    },
                },
            },
        });

        if (
            !feed ||
            !feed.enabled ||
            !feed.workspace.rssEnabled ||
            !feed.workspace.owner.emailVerified ||
            feed.workspace.owner.approvalStatus !== "APPROVED"
        ) {
            return unavailable();
        }

        const siteUrl = new URL(process.env.BETTER_AUTH_URL ?? "");

        if (!["http:", "https:"].includes(siteUrl.protocol)) {
            throw new Error("Invalid application URL.");
        }

        const replaceRules = readReplacementRules(feed.replaceRules);

        const itemsXml = feed.items
            .map((item) => {
                const processed = processRssContent(item.content, {
                    removeKeywords: feed.removeKeywords,
                    replaceRules,
                    headerText: feed.headerText,
                    footerText: feed.footerText,
                });

                // Rules may remove the entire content.
                if (!processed) return "";

                const html = escapeXml(processed.content)
                    .replace(/\r\n|\r|\n/g, "<br />");

                const sourceUrl = safeSourceUrl(item.sourceUrl);

                return `
    <item>
      <title>${escapeXml(processed.title)}</title>
      <guid isPermaLink="false">${escapeXml(item.id)}</guid>
      <pubDate>${item.publishedAt.toUTCString()}</pubDate>
      ${sourceUrl ? `<link>${escapeXml(sourceUrl)}</link>` : ""}
      <description>${escapeXml(html)}</description>
    </item>`;
            })
            .join("");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${escapeXml(siteUrl.origin + "/")}</link>
    <description>${escapeXml(feed.description)}</description>
    ${itemsXml}
  </channel>
</rss>`;

        return new Response(xml, {
            status: 200,
            headers: {
                ...responseHeaders,
                "Content-Type": "application/rss+xml; charset=utf-8",
            },
        });
    } catch {
        // Avoid logging the request URL: it contains the access token.
        console.error("RSS feed request failed.");

        return new Response("Feed temporarily unavailable.", {
            status: 503,
            headers: responseHeaders,
        });
    }
}