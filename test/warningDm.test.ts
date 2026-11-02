import { ButtonStyle } from "discord.js";
import { describe, expect, it } from "vitest";
import { conductWarnDmCard, warningDmCard } from "../src/render/cards.js";

/** Both warning DMs ask for the button to be pressed, and draw the same one. */

const cards = {
    activity: warningDmCard({
        warningId: "abc",
        windowLabel: "19 Oct to 1 Nov",
        totalMinutes: 24,
        requiredMinutes: 240,
        reason: "Short."
    }),
    conduct: conductWarnDmCard({
        warningId: "abc",
        tier: "caution",
        issuedBy: "<@1>",
        consequence: "This never stops counting.",
        reason: "Short."
    })
};

describe.each(Object.entries(cards))("the %s warning DM", (_kind, card) => {
    const json = card.components[0]!.toJSON() as unknown as {
        components: { type: number; content?: string; components?: Record<string, unknown>[] }[];
    };
    const body = json.components.find((part) => part.type === 10)?.content ?? "";
    const button = json.components.find((part) => part.type === 1)?.components?.[0];

    it("asks for the button to be pressed, and says that is not agreeing", () => {
        expect(body).toContain("**Once you've read this, please press the button below.**");
        expect(body).toContain("-# It doesn't mean you agree.");
    });

    it("ends on the ask, directly above the button", () => {
        expect(body.endsWith("It doesn't mean you agree.")).toBe(true);
    });

    it("draws a blurple button with a tick that still acknowledges", () => {
        expect(button).toMatchObject({
            custom_id: "warning:abc:ack",
            label: "I have read this",
            style: ButtonStyle.Primary,
            emoji: { name: "✅" }
        });
    });
});
