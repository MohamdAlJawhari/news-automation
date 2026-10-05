export type ReplacementRule = {
    find: string;
    replace: string;
};

const MAX_RULES = 50;
const MAX_RULE_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 100000;

export function parseRemoveKeywords(text: string): string[] {
    const keywords = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (
        keywords.length > MAX_RULES ||
        keywords.some((keyword) => keyword.length > MAX_RULE_LENGTH)
    ) {
        throw new Error(
            "Use at most 50 removal rules, with at most 200 characters each."
        );
    }

    return [...new Set(keywords)];
}

export function readReplacementRules(value: unknown): ReplacementRule[] {
    if (!Array.isArray(value) || value.length > MAX_RULES) {
        throw new Error("Use at most 50 replacement rules.");
    }

    return value.map((entry) => {
        if (
            !entry ||
            typeof entry !== "object" ||
            !("find" in entry) ||
            !("replace" in entry) ||
            typeof entry.find !== "string" ||
            typeof entry.replace !== "string"
        ) {
            throw new Error("Invalid replacement rule.");
        }

        const find = entry.find.trim();
        const replace = entry.replace.trim();

        if (
            !find ||
            find.length > MAX_RULE_LENGTH ||
            replace.length > MAX_RULE_LENGTH ||
            /[\r\n]/.test(find) ||
            /[\r\n]/.test(replace)
        ) {
            throw new Error(
                "Each replacement rule needs a search phrase. Both fields must be single-line text of at most 200 characters."
            );
        }

        return { find, replace };
    });
}

export function parseReplacementText(text: string): ReplacementRule[] {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const rules = lines.map((line, index) => {
        const separator = line.indexOf("=>");

        if (separator < 1) {
            throw new Error(
                `Replacement line ${index + 1} must use: word => replacement`
            );
        }

        return {
            find: line.slice(0, separator),
            replace: line.slice(separator + 2),
        };
    });

    return readReplacementRules(rules);
}

function replaceWholePhrase(
    text: string,
    find: string,
    replacement: string
): string {
    // Treat the user's phrase as literal text, not a regular expression.
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Letters, marks, numbers, connector punctuation and joining characters.
    const word = "[\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200C\\u200D]";

    const pattern = new RegExp(
        `(?<!${word})${escaped}(?!${word})`,
        "gu"
    );

    let outputLength = text.length;

    // A callback keeps replacement text such as "$&" literal.
    return text.replace(pattern, (matched) => {
        outputLength += replacement.length - matched.length;

        if (outputLength > MAX_OUTPUT_LENGTH) {
            throw new Error(
                "RSS rules expanded an item beyond 100,000 characters. Shorten the replacement rules."
            );
        }

        return replacement;
    });
}

export function processRssContent(
    content: string,
    settings: {
        removeKeywords: string[];
        replaceRules: ReplacementRule[];
        headerText: string;
        footerText: string;
    }
): { title: string; content: string } | null {
    if (content.length > MAX_OUTPUT_LENGTH) {
        throw new Error("RSS item exceeds the processing limit.");
    }

    let text = content;

    // 1. Remove keywords in saved order.
    for (const keyword of settings.removeKeywords) {
        if (keyword) {
            text = replaceWholePhrase(text, keyword, "");
        }
    }

    // 2. Replace words/phrases in saved order.
    for (const rule of settings.replaceRules) {
        text = replaceWholePhrase(text, rule.find, rule.replace);
    }

    // Tidy spaces while preserving paragraphs.
    text = text
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Do not publish an item containing only the header/footer.
    if (!text) return null;

    const firstLine = text.split("\n").find((line) => line.trim())!;
    const characters = Array.from(firstLine);

    const title =
        characters.length > 140
            ? characters.slice(0, 139).join("") + "…"
            : characters.join("");

    // 3. Header.
    // 4. Footer.
    const finalContent = [
        settings.headerText.trim(),
        text,
        settings.footerText.trim(),
    ]
        .filter(Boolean)
        .join("\n\n");

    if (finalContent.length > MAX_OUTPUT_LENGTH) {
        throw new Error("Processed RSS item exceeds 100,000 characters.");
    }

    return { title, content: finalContent };
}