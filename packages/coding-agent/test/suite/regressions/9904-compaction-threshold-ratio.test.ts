import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { shouldCompact } from "../../../src/core/compaction/compaction.ts";
import type { SessionBeforeCompactEvent } from "../../../src/core/extensions/index.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

function seedHistory(harness: Harness, totalTokens: number): void {
	for (const label of ["old", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"));
		harness.sessionManager.appendMessage({
			...assistant,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

// Regression for #9904: the trigger ratio must not change the summary output budget.
describe("Context-relative compaction threshold", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each([272000, 900000])("uses the same 85 percent policy for a %i-token model", (contextWindow) => {
		const settings = SettingsManager.inMemory({ compaction: { thresholdRatio: 0.85 } }).getCompactionSettings();
		const threshold = Math.floor(contextWindow * 0.85);
		expect(shouldCompact(threshold, contextWindow, settings)).toBe(false);
		expect(shouldCompact(threshold + 1, contextWindow, settings)).toBe(true);
		expect(settings.reserveTokens).toBe(16384);
	});
	it("rounds down fractional thresholds and preserves the disabled setting", () => {
		const manager = SettingsManager.inMemory({ compaction: { thresholdRatio: 0.85 } });
		expect(shouldCompact(86, 101, manager.getCompactionSettings())).toBe(true);
		manager.setCompactionEnabled(false);
		expect(shouldCompact(1000, 101, manager.getCompactionSettings())).toBe(false);
	});
	it("keeps the reserve-token trigger when no ratio is configured", () => {
		const manager = SettingsManager.inMemory({ compaction: { reserveTokens: 2000 } });
		expect(shouldCompact(8000, 10000, manager.getCompactionSettings())).toBe(false);
		expect(shouldCompact(8001, 10000, manager.getCompactionSettings())).toBe(true);
	});
	it.each([0, 1, -0.5, 1.01, Number.NaN, Infinity, -Infinity, "0.85", null, true])(
		"rejects invalid ratio %s",
		(ratio) => {
			const manager = SettingsManager.inMemory();
			manager.applyOverrides({ compaction: { thresholdRatio: ratio } } as unknown as Partial<Settings>);
			expect(() => manager.getCompactionSettings()).toThrow("compaction.thresholdRatio");
		},
	);
	it("merges project ratios and exact model overrides independently of token budgets", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: {
					thresholdRatio: 0.85,
					modelOverrides: { "fixture/small": { thresholdRatio: 0.7, reserveTokens: 3000 } },
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: { thresholdRatio: 0.8, modelOverrides: { "fixture/small": { keepRecentTokens: 1000 } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getCompactionSettings({ provider: "fixture", id: "small" })).toEqual({
			enabled: true,
			thresholdRatio: 0.7,
			reserveTokens: 3000,
			keepRecentTokens: 1000,
		});
		expect(manager.getCompactionSettings({ provider: "fixture", id: "big" }).thresholdRatio).toBe(0.8);
	});
	it("rejects an invalid matching override and an invalid ordinary ratio even with an override", () => {
		const model = { provider: "fixture", id: "model" };
		const manager = SettingsManager.inMemory({
			compaction: { thresholdRatio: 0.8, modelOverrides: { "fixture/model": { thresholdRatio: 0 } } },
		});
		expect(() => manager.getCompactionSettings(model)).toThrow(
			'compaction.modelOverrides["fixture/model"].thresholdRatio',
		);
		manager.applyOverrides({
			compaction: { thresholdRatio: 1, modelOverrides: { "fixture/model": { thresholdRatio: 0.8 } } },
		});
		expect(() => manager.getCompactionSettings(model)).toThrow("compaction.thresholdRatio");
	});
	it.each(["manual", "pre-prompt", "post-run", "overflow"] as const)(
		"propagates the ratio through %s compaction",
		async (path) => {
			const preparations: SessionBeforeCompactEvent[] = [];
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 10000 }],
				tools: [],
				settings: {
					compaction: {
						enabled: path !== "manual",
						reserveTokens: 100,
						keepRecentTokens: 150,
						thresholdRatio: 0.5,
					},
				},
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							preparations.push(event);
							return {
								compaction: {
									summary: "compacted history",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			seedHistory(harness, path === "pre-prompt" ? 6000 : 650);
			if (path === "manual") await harness.session.compact();
			else {
				harness.setResponses(
					path === "overflow"
						? [
								fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
								fauxAssistantMessage("recovered"),
							]
						: [fauxAssistantMessage(path === "post-run" ? "z".repeat(24000) : "done")],
				);
				await harness.session.prompt("continue");
			}
			expect(preparations).toHaveLength(1);
			expect(preparations[0]?.preparation.settings).toEqual({
				enabled: path !== "manual",
				reserveTokens: 100,
				keepRecentTokens: 150,
				thresholdRatio: 0.5,
			});
			expect(preparations[0]?.reason).toBe(
				path === "manual" ? "manual" : path === "overflow" ? "overflow" : "threshold",
			);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);
	it("keeps the built-in summary output cap independent from the ratio", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 3000 }],
			tools: [],
			settings: { compaction: { thresholdRatio: 0.5, reserveTokens: 2000, keepRecentTokens: 150 } },
		});
		harnesses.push(harness);
		seedHistory(harness, 6000);
		const budgets: Array<number | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				budgets.push(options?.maxTokens);
				return fauxAssistantMessage("built-in summary");
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("continue");
		expect(budgets).toEqual([1600]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
