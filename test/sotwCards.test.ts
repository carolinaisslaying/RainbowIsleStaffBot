import { describe, expect, it } from "vitest";
import {
    colourSettingsCard,
    colourStatusText,
    congratsCard,
    handoffText,
    reminderCard,
    weekChoiceCard
} from "../src/render/sotwCards.js";
import { SOTW_CONGRATULATIONS, pickCongratulation } from "../src/render/sotwMessages.js";
import { EMOJI } from "../src/render/emoji.js";
import { COLOUR } from "../src/render/theme.js";

const json = (card: { components: { toJSON(): unknown }[] }) =>
    JSON.stringify(card.components.map((component) => component.toJSON()));

describe("the reminder", () => {
    it("says what is decided, who is barred and who did well, and where to act", () => {
        const body = json(
            reminderCard({
                nextWeekLabel: "Mon 5 Oct to Sun 11 Oct",
                decision: "Not decided yet. If nobody is picked, the bot draws a name at random.",
                barred: ["Robin", "Sam"],
                leaders: [
                    { name: "Ashley", minutes: 300, pendingLeave: false },
                    { name: "Kai", minutes: 250, pendingLeave: true }
                ],
                target: 120,
                setCommand: "</sotw set:1>"
            })
        );
        expect(body).toContain(EMOJI.staffOfWeek);
        expect(body).toContain("draws a name at random");
        expect(body).toContain("Robin");
        expect(body).toContain("Ashley");
        expect(body).toContain("has a leave request for that week waiting for a decision");
        expect(body).toContain("</sotw set:1>");
        expect(body).not.toContain("⚠");
    });
});

describe("the week choice", () => {
    it("offers the rest of this week and next week, carrying the staffId so a stale card cannot act on somebody else's pick", () => {
        const body = json(
            weekChoiceCard({ staffId: "64f000000000000000000001", name: "Robin", currentLabel: "this", nextLabel: "next" })
        );
        expect(body).toContain("sotw:rest:64f000000000000000000001");
        expect(body).toContain("sotw:next:64f000000000000000000001");
        expect(body).toContain("sotw:cancel");
    });
});

describe("the handoff notice", () => {
    it("says how the holder came to hold it", () => {
        expect(handoffText({ kind: "picked", holder: "Robin", by: "<@1>" })).toContain("picked by <@1>");
        const random = handoffText({ kind: "random", holder: "Robin", pool: ["Robin", "Sam", "Kai"], failedPick: null });
        expect(random).toContain("drawn at random");
        expect(random).toContain("Sam");
        expect(handoffText({ kind: "skipped", by: "<@1>" })).toContain("skipped");
        expect(handoffText({ kind: "empty", failedPick: null })).toContain("Nobody who could be picked met the weekly minimum");
    });

    it("says why the person picked could not have it", () => {
        const text = handoffText({ kind: "random", holder: "Sam", pool: ["Sam"], failedPick: "**Robin** has left." });
        expect(text).toContain("The person who was picked could not have it.");
        expect(text).toContain("**Robin** has left.");
    });
});

describe("the colour card", () => {
    it("says what saving will do, for each kind of member", () => {
        expect(colourStatusText("holding")).toContain("changes the role's colour now");
        expect(colourStatusText("saved")).toContain("next time");
        expect(colourStatusText("executive")).toContain("Executives cannot be Staff of the Week");
    });

    it("offers the picker link, a code and clearing when nothing is staged", () => {
        const body = json(
            colourSettingsCard({
                status: "saved",
                savedLabel: "Solid #FF66AA",
                staged: null,
                pickerUrl: "https://colour.example.nz/#v=1",
                preview: null,
                message: null,
                note: null
            })
        );
        expect(body).toContain("https://colour.example.nz/#v=1");
        expect(body).toContain("sotwColour:code");
        expect(body).toContain("sotwColour:clear");
        expect(body).not.toContain("sotwColour:save");
    });

    it("offers save, edit and cancel once something is staged", () => {
        const body = json(
            colourSettingsCard({
                status: "holding",
                savedLabel: "No colour",
                staged: { label: "Holographic" },
                pickerUrl: null,
                preview: null,
                message: null,
                note: "Holographic shows as a single colour here."
            })
        );
        expect(body).toContain("sotwColour:save");
        expect(body).toContain("sotwColour:code");
        expect(body).toContain("sotwColour:cancel");
        expect(body).toContain("Holographic shows as a single colour here.");
    });

    it("is drawn in the feature's colour", () => {
        const card = colourSettingsCard({
            status: "saved",
            savedLabel: "No colour",
            staged: null,
            pickerUrl: null,
            preview: null,
            message: null,
            note: null
        });
        expect((card.components[0].toJSON() as { accent_color: number }).accent_color).toBe(COLOUR.staffOfWeek);
    });
});

describe("the congratulation", () => {
    it("comes from the owner's list and carries the colour line", () => {
        expect(SOTW_CONGRATULATIONS.length).toBeGreaterThan(0);
        expect(SOTW_CONGRATULATIONS).toContain(pickCongratulation(() => 0.5));
        const body = json(congratsCard({ message: "Well done!", colourLine: "Your colour is on the role.", preview: null }));
        expect(body).toContain("Well done!");
        expect(body).toContain("Your colour is on the role.");
    });
});
