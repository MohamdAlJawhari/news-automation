"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import {
  parseRemoveKeywords,
  parseReplacementText,
  readReplacementRules,
} from "@/lib/rss-rules";

export type RssSettingsState = {
  message: string;
  success?: boolean;
  saved?: string;
};

export type RssLinkState = {
  message: string;
  feedUrl?: string;
};

export type RssRulesState = {
  success: boolean;
  message: string;
};

export async function saveRssRules(
  _previous: RssRulesState,
  formData: FormData,
): Promise<RssRulesState> {
  const { workspace, source } = await requireRssSource(formData);

  const removeText = formData.get("removeKeywords");
  const replaceText = formData.get("replaceRules");

  if (
    typeof removeText !== "string" ||
    typeof replaceText !== "string" ||
    removeText.length > 12000 ||
    replaceText.length > 25000
  ) {
    return {
      success: false,
      message: "Invalid rules or rules exceed the allowed size.",
    };
  }

  let removeKeywords: string[];
  let replaceRules: { find: string; replace: string }[];

  try {
    removeKeywords = parseRemoveKeywords(removeText);
    replaceRules = parseReplacementText(replaceText);
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Invalid RSS rules.",
    };
  }

  try {
    await prisma.rssFeed.upsert({
      where: {
        sourceChannelId: source.id,
      },
      create: {
        workspaceId: workspace.id,
        sourceChannelId: source.id,
        title: `@${source.username} — News`,
        removeKeywords,
        replaceRules,
      },
      update: {
        removeKeywords,
        replaceRules,
      },
    });
  } catch {
    return {
      success: false,
      message: "Could not save the rules. Please try again.",
    };
  }

  revalidatePath("/workspace/rss");

  return {
    success: true,
    message:
      "Rules saved. They apply to existing and future items on the next feed request.",
  };
}

async function requireRssSource(formData: FormData) {
  const { workspace } = await requireWorkspaceAccess("rss");
  const sourceId = formData.get("sourceId");

  if (typeof sourceId !== "string" || !sourceId || sourceId.length > 100) {
    notFound();
  }

  const source = await prisma.sourceChannel.findFirst({
    where: {
      id: sourceId,
      workspaceId: workspace.id,
    },
    select: {
      id: true,
      username: true,
    },
  });

  if (!source) notFound();

  return { workspace, source };
}

export async function saveRssSettings(
  previous: RssSettingsState,
  formData: FormData,
): Promise<RssSettingsState> {
  const { workspace, source } = await requireRssSource(formData);

  const title = formData.get("title");
  const description = formData.get("description");
  const headerText = formData.get("headerText");
  const footerText = formData.get("footerText");
  const enabled = formData.get("enabled") === "on";
  const removeText = formData.get("removeKeywords");
  const replaceText = formData.get("replaceRules");
  let removeKeywords: string[];
  let replaceRules: { find: string; replace: string }[];
  try {
    if (
      typeof removeText !== "string" ||
      removeText.length > 12000 ||
      typeof replaceText !== "string" ||
      replaceText.length > 25000
    ) {
      throw new Error("Invalid rules or rules exceed the allowed size.");
    }
    removeKeywords = parseRemoveKeywords(removeText);
    replaceRules = readReplacementRules(JSON.parse(replaceText));
  } catch (error) {
    return {
      success: false,
      saved: previous.saved,
      message: error instanceof Error ? error.message : "Invalid RSS rules.",
    };
  }

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 200 ||
    typeof description !== "string" ||
    description.length > 2000 ||
    typeof headerText !== "string" ||
    headerText.length > 2000 ||
    typeof footerText !== "string" ||
    footerText.length > 2000
  ) {
    return {
      success: false,
      saved: previous.saved,
      message:
        "Enter a title of 1–200 characters. Other fields must not exceed 2,000 characters each.",
    };
  }

  const settings = {
    title: title.trim(),
    description: description.trim(),
    headerText: headerText.trim(),
    footerText: footerText.trim(),
    enabled,
    removeKeywords,
    replaceRules,
  };

  try {
    await prisma.rssFeed.upsert({
      where: {
        sourceChannelId: source.id,
      },
      create: {
        workspaceId: workspace.id,
        sourceChannelId: source.id,
        ...settings,
      },
      update: settings,
    });
  } catch {
    return {
      success: false,
      saved: previous.saved,
      message: "Could not save RSS settings. Please try again.",
    };
  }

  revalidatePath("/workspace/rss");

  revalidatePath("/workspace/rss/items");
  revalidatePath("/workspace/sources");

  return {
    success: true,
    saved: JSON.stringify(settings),
    message: enabled
      ? "Channel settings saved. The feed is available if an access link exists."
      : "Channel settings saved. This feed is disabled.",
  };
}

export async function manageRssLink(
  _previous: RssLinkState,
  formData: FormData,
): Promise<RssLinkState> {
  const { workspace, source } = await requireRssSource(formData);
  const intent = formData.get("intent");

  if (intent !== "rotate" && intent !== "revoke") {
    return { message: "Invalid action." };
  }

  if (intent === "revoke") {
    try {
      await prisma.rssFeed.updateMany({
        where: {
          sourceChannelId: source.id,
          workspaceId: workspace.id,
        },
        data: { tokenHash: null },
      });
    } catch {
      return {
        message: "Could not revoke the link. Please try again.",
      };
    }

    revalidatePath("/workspace/rss");

    return {
      message: "This channel's access link has been revoked.",
    };
  }

  try {
    const baseUrl = new URL(process.env.BETTER_AUTH_URL ?? "");

    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new Error("Invalid application URL.");
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await prisma.rssFeed.upsert({
      where: {
        sourceChannelId: source.id,
      },
      create: {
        workspaceId: workspace.id,
        sourceChannelId: source.id,
        title: `@${source.username} — News`,
        tokenHash,
      },
      update: { tokenHash },
    });

    revalidatePath("/workspace/rss");

    return {
      message:
        "New channel link created. Copy it now. Any previous link for this channel is invalid.",
      feedUrl: new URL(`/rss/${token}`, baseUrl.origin).toString(),
    };
  } catch {
    return {
      message:
        "Could not create the link. Check BETTER_AUTH_URL and try again.",
    };
  }
}
