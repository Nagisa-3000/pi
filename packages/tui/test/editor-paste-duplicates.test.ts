import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function duplicatePaste(content: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	editor.handleInput(`\x1b[200~${content}\x1b[201~`);
	editor.handleInput("\x15"); // Cut to the start of the line.
	editor.handleInput("\x19");
	editor.handleInput("\x19");
	return editor;
}

const content = Array.from({ length: 11 }, (_, i) => `line ${i}`).join("\n");

// Regression for #10351: deleting one marker must retain the other marker's payload.
describe("Duplicate paste markers", () => {
	it("submits the remaining paste after backspacing the second copy", () => {
		const editor = duplicatePaste(content);
		assert.equal(editor.getExpandedText(), content + content);
		editor.handleInput("\x7f");
		assert.equal(editor.getExpandedText(), content);
		let submitted: string | undefined;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.handleInput("\r");
		assert.equal(submitted, content);
	});

	it("keeps the second copy when the first copy is backspaced", () => {
		const editor = duplicatePaste(content);
		editor.handleInput("\x01");
		editor.handleInput("\x1b[C");
		editor.handleInput("\x7f");
		assert.equal(editor.getExpandedText(), content);
	});

	it("retains a copy on another line", () => {
		const editor = duplicatePaste(content);
		editor.handleInput("\x01");
		editor.handleInput("\x1b[C");
		editor.handleInput("\n");
		editor.handleInput("\x1b[C");
		editor.handleInput("\x7f");
		assert.equal(editor.getExpandedText(), `${content}\n`);
	});

	it("keeps duplicate content separate from a later paste", () => {
		const editor = duplicatePaste(content);
		editor.handleInput("\x7f");
		const other = "other ".repeat(200);
		editor.handleInput(`\x1b[200~${other}\x1b[201~`);
		assert.equal(editor.getExpandedText(), content + other);
	});

	it("restores both copies and their payload on undo", () => {
		const editor = duplicatePaste(content);
		editor.handleInput("\x7f");
		assert.equal(editor.getExpandedText(), content);
		editor.handleInput("\x1b[45;5u");
		assert.equal(editor.getExpandedText(), content + content);
	});

	it("retains a duplicated single-line paste", () => {
		const text = "text ".repeat(250);
		const editor = duplicatePaste(text);
		editor.handleInput("\x7f");
		assert.equal(editor.getExpandedText(), text);
	});

	it("allows a new paste after the last copy is removed", () => {
		const editor = duplicatePaste(content);
		editor.handleInput("\x7f");
		editor.handleInput("\x7f");
		assert.equal(editor.getText(), "");
		const other = "new ".repeat(300);
		editor.handleInput(`\x1b[200~${other}\x1b[201~`);
		assert.equal(editor.getExpandedText(), other);
	});
});
