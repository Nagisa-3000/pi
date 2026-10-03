import { createAssistantMessageEventStream, fauxAssistantMessage, type Models, Type } from "@earendil-works/pi-ai";
import { defineTool, type Harness, LiveDoc, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSettings } from "../src/harness/agent.ts";
import { Progress } from "../src/harness/output.ts";
import { allEntries, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const opened: Harness[] = [];
const release: (() => void)[] = [];
afterEach(async () => {
	for (const done of release.splice(0)) done();
	for (const harness of opened.splice(0)) await harness.close(context);
	vi.useRealTimers();
});

// #10357: remote storage needs control over progress writes without delaying terminal commits.
describe("progress intervals", () => {
	it("uses 100 ms defaults and merges each interval independently", () => {
		expect(resolveSettings(undefined).progress).toEqual({ partialIntervalMs: 100, outputIntervalMs: 100 });
		expect(resolveSettings({ progress: { partialIntervalMs: 1000 } }).progress).toEqual({
			partialIntervalMs: 1000,
			outputIntervalMs: 100,
		});
		expect(resolveSettings({ progress: { outputIntervalMs: 2000 } }).progress).toEqual({
			partialIntervalMs: 100,
			outputIntervalMs: 2000,
		});
		expect(resolveSettings({ progress: { partialIntervalMs: 0, outputIntervalMs: 2_147_483_647 } }).progress).toEqual(
			{ partialIntervalMs: 0, outputIntervalMs: 2_147_483_647 },
		);
	});

	for (const name of ["partialIntervalMs", "outputIntervalMs"] as const) {
		it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
			`rejects invalid ${name} %s`,
			(interval) => {
				expect(() => resolveSettings({ progress: { [name]: interval } })).toThrow(`progress.${name}`);
			},
		);
	}

	it("coalesces output changes using the configured minimum and preserves byte backpressure", async () => {
		vi.useFakeTimers({ now: 0 });
		const commits: number[] = [];
		let bytes = 0;
		const progress = new Progress(
			async () => {
				commits.push(Date.now());
				return bytes;
			},
			() => {},
			1000,
		);
		progress.mark();
		await vi.advanceTimersByTimeAsync(0);
		progress.mark();
		progress.mark();
		await vi.advanceTimersByTimeAsync(999);
		expect(commits).toEqual([0]);
		bytes = 200 * 1024;
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toEqual([0, 1000]);
		progress.mark();
		await vi.advanceTimersByTimeAsync(1999);
		expect(commits).toEqual([0, 1000]);
		await vi.advanceTimersByTimeAsync(1);
		expect(commits).toEqual([0, 1000, 3000]);
		await progress.stop();
	});

	it("uses the configured pause after a failed progress commit", async () => {
		vi.useFakeTimers({ now: 0 });
		const error = new Error("storage failed");
		const write = vi.fn<() => Promise<number>>().mockRejectedValueOnce(error).mockResolvedValue(0);
		const report = vi.fn();
		const progress = new Progress(write, report, 1000);
		await expect(progress.markAndWait()).rejects.toBe(error);
		progress.mark();
		await vi.advanceTimersByTimeAsync(999);
		expect(write).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(write).toHaveBeenCalledTimes(2);
		expect(report).toHaveBeenCalledWith(error);
		await progress.stop();
	});

	it("hands pending waiters to the final commit and cancels a long interval on stop", async () => {
		vi.useFakeTimers({ now: 0 });
		const write = vi.fn(async () => 0);
		const progress = new Progress(write, () => {}, 60_000);
		await progress.markAndWait();
		const pending = progress.markAndWait();
		const waiters = await progress.stop();
		expect(waiters).toHaveLength(1);
		waiters[0]!.resolve();
		await pending;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(write).toHaveBeenCalledTimes(1);
	});

	function controlledStream() {
		const base = chatSetup();
		const requested = Promise.withResolvers<void>();
		const events = createAssistantMessageEventStream();
		const streamSimple: Models["streamSimple"] = (_model, _request, options) => {
			options?.signal?.addEventListener(
				"abort",
				() => {
					const error = fauxAssistantMessage("aborted", { stopReason: "aborted" });
					events.push({ type: "error", reason: "aborted", error });
					events.end(error);
				},
				{ once: true },
			);
			requested.resolve();
			return events;
		};
		const models = new Proxy(base.models, {
			get(target, property) {
				if (property === "streamSimple") return streamSimple;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return { setup: { ...base, models }, requested: requested.promise, events };
	}

	it.each([undefined, 1000, 0])(
		"commits partials using interval %s and ends without stale progress",
		async (configured) => {
			const { setup, requested, events } = controlledStream();
			if (configured !== undefined) setup.settings.progress = { partialIntervalMs: configured };
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			opened.push(harness);
			vi.useFakeTimers({ now: 1000 });
			const submission = await root.submit({ type: "input", content: "hi" }, context);
			await requested;
			const interval = configured ?? 100;
			events.push({ type: "start", partial: fauxAssistantMessage("first", { stopReason: "pending" }) });
			if (interval > 0) {
				await vi.advanceTimersByTimeAsync(interval - 1);
				expect((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message).toBeUndefined();
			}
			events.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "latest",
				partial: fauxAssistantMessage("latest", { stopReason: "pending" }),
			});
			await vi.advanceTimersByTimeAsync(1);
			expect(textOf((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message)).toBe("latest");
			events.push({
				type: "text_delta",
				contentIndex: 0,
				delta: "pending",
				partial: fauxAssistantMessage("pending", { stopReason: "pending" }),
			});
			const final = fauxAssistantMessage("complete answer");
			events.push({ type: "done", reason: "stop", message: final });
			events.end(final);
			expect(await submission.wait(context)).toMatchObject({ status: "done" });
			expect(textOf((await allEntries(root)).at(-1)?.model?.[0])).toBe("complete answer");
			expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
			await vi.advanceTimersByTimeAsync(Math.max(1, interval * 2));
			expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
			expect(setup.reports).toEqual([]);
		},
	);

	it("uses the configured interval for partials received during an in-flight commit", async () => {
		const { setup, requested, events } = controlledStream();
		setup.settings.progress = { partialIntervalMs: 1000 };
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, setup);
		opened.push(harness);
		vi.useFakeTimers({ now: 1000 });
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await requested;
		const held = storage.holdCommits();
		release.push(held.release);
		events.push({ type: "start", partial: fauxAssistantMessage("first", { stopReason: "pending" }) });
		await vi.advanceTimersByTimeAsync(1000);
		await held.entered;
		events.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "latest",
			partial: fauxAssistantMessage("latest", { stopReason: "pending" }),
		});
		await vi.advanceTimersByTimeAsync(0);
		held.release();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(999);
		expect(textOf((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message)).toBe("first");
		await vi.advanceTimersByTimeAsync(1);
		expect(textOf((await harness.snapshot(LiveDoc, root.id, context))?.generation?.message)).toBe("latest");
		const final = fauxAssistantMessage("done");
		events.push({ type: "done", reason: "stop", message: final });
		events.end(final);
		await submission.wait(context);
		expect(setup.reports).toEqual([]);
	});

	it("aborts with the committed partial and cancels pending partial writes", async () => {
		const { setup, requested, events } = controlledStream();
		setup.settings.progress = { partialIntervalMs: 1000 };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		opened.push(harness);
		vi.useFakeTimers({ now: 1000 });
		await root.submit({ type: "input", content: "hi" }, context);
		await requested;
		events.push({ type: "start", partial: fauxAssistantMessage("stored partial", { stopReason: "pending" }) });
		await vi.advanceTimersByTimeAsync(1000);
		events.push({
			type: "text_delta",
			contentIndex: 0,
			delta: "queued",
			partial: fauxAssistantMessage("queued partial", { stopReason: "pending" }),
		});
		await vi.advanceTimersByTimeAsync(0);
		await root.abort(context);
		const last = (await allEntries(root)).at(-1)?.model?.[0];
		expect(last).toMatchObject({ stopReason: "aborted" });
		expect(textOf(last)).toBe("stored partial");
		await vi.advanceTimersByTimeAsync(2000);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(setup.reports).toEqual([]);
	});

	it("throttles tool output and settles waiting details with the terminal commit", async () => {
		const { setup, requested, events } = controlledStream();
		setup.settings.progress = { outputIntervalMs: 1000 };
		const started = Promise.withResolvers<ToolExecutionApi>();
		const finish = Promise.withResolvers<void>();
		release.push(finish.resolve);
		addTool(
			setup.registry,
			defineTool({
				name: "log",
				description: "Report output",
				parameters: Type.Object({}),
				execute: async (_args, api) => {
					api.output("one");
					started.resolve(api);
					await finish.promise;
					return { control: { terminate: true } };
				},
			}),
		);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		opened.push(harness);
		vi.useFakeTimers({ now: 1000 });
		const submission = await root.submit({ type: "input", content: "log" }, context);
		await requested;
		const calls = fauxAssistantMessage([{ type: "toolCall", id: "c1", name: "log", arguments: {} }], {
			stopReason: "toolUse",
		});
		events.push({ type: "done", reason: "toolUse", message: calls });
		events.end(calls);
		const api = await started.promise;
		await vi.advanceTimersByTimeAsync(0);
		api.output("two");
		await vi.advanceTimersByTimeAsync(999);
		const live = await harness.snapshot(LiveDoc, root.id, context);
		expect(live?.tools?.[0]?.output).toBe("one");
		api.output("three");
		// A final result must not wait for the remaining throttle window.
		const details = api.details({ finished: true }, context);
		finish.resolve();
		expect(await submission.wait(context)).toMatchObject({ status: "done" });
		await details;
		const result = (await allEntries(root)).find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
		expect(textOf(result)).toBe("onetwothree");
		expect(result).toMatchObject({ details: { finished: true } });
		await vi.advanceTimersByTimeAsync(2000);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(setup.reports).toEqual([]);
	});
});
