import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type KeyId, matchesKey, parseKey } from "../src/keys.ts";

// Regression for #10369: explicit Escape modifiers must match their parsed key names.
describe("Modified Escape", () => {
	const keys = [
		"escape",
		"shift+escape",
		"alt+escape",
		"shift+alt+escape",
		"ctrl+escape",
		"shift+ctrl+escape",
		"ctrl+alt+escape",
		"shift+ctrl+alt+escape",
		"super+escape",
		"shift+super+escape",
		"alt+super+escape",
		"shift+alt+super+escape",
		"ctrl+super+escape",
		"shift+ctrl+super+escape",
		"ctrl+alt+super+escape",
		"shift+ctrl+alt+super+escape",
	] as const;
	for (const [modifier, key] of keys.entries()) {
		it(`matches ${key} with both protocols and lock states`, () => {
			for (const locks of [0, 64, 128, 192]) {
				const value = modifier + locks + 1;
				for (const sequence of [`\x1b[27;${value}u`, `\x1b[27;${value};27~`]) {
					assert.equal(parseKey(sequence), key);
					assert.equal(matchesKey(sequence, key), true, JSON.stringify(sequence));
					assert.equal(matchesKey(sequence, keys[modifier ^ 4]!), false);
				}
			}
		});
	}
	it("matches the esc alias and Kitty repeat events", () => {
		assert.equal(matchesKey("\x1b[27;5u", "ctrl+esc"), true);
		assert.equal(matchesKey("\x1b[27;5;27~", "ctrl+esc"), true);
		assert.equal(matchesKey("\x1b[27;5:2u", "ctrl+escape"), true);
	});
	it("keeps raw Escape unmodified and rejects ambiguous double Escape", () => {
		assert.equal(matchesKey("\x1b", "escape"), true);
		for (const key of keys.slice(1)) assert.equal(matchesKey("\x1b", key), false);
		for (const key of keys) assert.equal(matchesKey("\x1b\x1b", key), false);
	});
	it("does not ignore unsupported modifier bits", () => {
		for (const sequence of ["\x1b[27;17u", "\x1b[27;17;27~"]) {
			assert.equal(parseKey(sequence), undefined);
			assert.equal(matchesKey(sequence, "escape"), false);
		}
	});
	it("ignores lock bits consistently for modifyOtherKeys shortcuts", () => {
		const shortcuts: Array<[number, number, KeyId]> = [
			[13, 1, "shift+enter"],
			[127, 4, "ctrl+backspace"],
			[99, 4, "ctrl+c"],
		];
		for (const [codepoint, modifier, key] of shortcuts) {
			for (const locks of [64, 128, 192]) {
				const sequence = `\x1b[27;${modifier + locks + 1};${codepoint}~`;
				assert.equal(parseKey(sequence), key);
				assert.equal(matchesKey(sequence, key), true);
			}
		}
	});
});
