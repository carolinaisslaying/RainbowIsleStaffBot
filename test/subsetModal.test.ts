import { describe, expect, it } from "vitest";
import { SUBSET_MAX, reviewSubsetModal } from "../src/render/modals.js";

/**
 * "Decide some" carries the whole decision in one modal: who, what and why.
 * These assert the parts a reader cannot check for themselves — that nothing
 * arrives pre-ticked, that a queue longer than Discord's checkbox limit says so
 * rather than silently dropping people, and that the values are the assessment
 * ids the handler reads back.
 */

const row = (index: number) => ({
    assessmentId: `65a1b2c3d4e5f6a7b8c9d0${String(index).padStart(2, "0")}`,
    name: `Member ${index}`,
    detail: `${index * 10} of 240 minutes`
});

const rows = (count: number) => Array.from({ length: count }, (_, index) => row(index));

interface CheckboxJson {
    type: number;
    custom_id: string;
    min_values?: number;
    max_values?: number;
    options: { value: string; label: string; default?: boolean }[];
}

function build(count: number, totalRemaining = count) {
    const json = reviewSubsetModal({
        fortnightIndex: 4,
        rows: rows(count),
        totalRemaining
    }).toJSON() as unknown as {
        custom_id: string;
        components: { type: number; content?: string; component?: unknown }[];
    };

    const labels = json.components.filter((child) => child.type === 18);
    return {
        json,
        blurb: json.components.find((child) => child.type === 10)?.content ?? "",
        checkbox: labels[0].component as CheckboxJson,
        radio: labels[1].component as CheckboxJson,
        reason: labels[2].component as { custom_id: string; required?: boolean }
    };
}

describe("the subset modal", () => {
    it("carries who, what and why in one modal", () => {
        const built = build(3);
        expect(built.checkbox.custom_id).toBe("rows");
        expect(built.radio.custom_id).toBe("outcome");
        expect(built.reason.custom_id).toBe("reason");
    });

    it("names the fortnight in its own id, so the handler needs no state", () => {
        expect(build(3).json.custom_id).toBe("reviewSubset:4");
    });

    it("starts with nothing ticked", () => {
        // The safe empty state for a subset: a mistimed submit decides nobody
        // rather than everybody, and "Decide all" already exists for that.
        for (const option of build(5).checkbox.options) {
            expect(option.default).toBe(false);
        }
    });

    it("requires at least one tick", () => {
        expect(build(5).checkbox.min_values).toBe(1);
    });

    it("lets every row shown be ticked at once", () => {
        expect(build(5).checkbox.max_values).toBe(5);
    });

    it("carries the assessment id as each value", () => {
        // What the handler reads back to find the rows. A display name would not
        // survive two members sharing one.
        expect(build(3).checkbox.options.map((option) => option.value)).toEqual([
            row(0).assessmentId,
            row(1).assessmentId,
            row(2).assessmentId
        ]);
    });

    it("shows the figures beside each name", () => {
        // A subset is chosen on the evidence, not on remembering which name was
        // which.
        expect(build(3).checkbox.options[1]).toMatchObject({
            label: "Member 1",
            description: "10 of 240 minutes"
        });
    });

    it("offers exactly the three outcomes a bulk run can take", () => {
        // Never reopen: that is a decision about a decided row, one at a time.
        expect(build(3).radio.options.map((option) => option.value)).toEqual([
            "warn",
            "excuse",
            "dismiss"
        ]);
    });
});

describe("a queue longer than Discord's checkbox limit", () => {
    it("never offers more options than the cap", () => {
        expect(build(SUBSET_MAX + 5).checkbox.options).toHaveLength(SUBSET_MAX);
    });

    it("says it is showing a subset rather than dropping people silently", () => {
        const blurb = build(SUBSET_MAX + 5, SUBSET_MAX + 5).blurb;
        expect(blurb).toContain(`Showing ${SUBSET_MAX} of ${SUBSET_MAX + 5}`);
        expect(blurb).toContain("press the button again");
    });

    it("caps max_values at what it actually shows", () => {
        expect(build(SUBSET_MAX + 5).checkbox.max_values).toBe(SUBSET_MAX);
    });

    it("does not claim truncation when everything fits", () => {
        const blurb = build(SUBSET_MAX, SUBSET_MAX).blurb;
        expect(blurb).not.toContain("Showing");
        expect(blurb).toContain(`${SUBSET_MAX} undecided rows`);
    });

    it("reads correctly for a single remaining row", () => {
        expect(build(1, 1).blurb).toContain("1 undecided row.");
    });
});
