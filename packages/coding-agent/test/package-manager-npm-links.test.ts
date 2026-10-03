import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type Layout = "external scope" | "external node_modules" | "prefix sibling scope";
type Operation = "install" | "remove" | "update";

// #10399: npm prunes packages reached through a scope junction, including the host installation.
describe("managed npm directory links", () => {
	let root: string;
	let agentDir: string;
	let callsPath: string;
	let commandPath: string;
	let settings: SettingsManager;
	let manager: DefaultPackageManager;

	beforeEach(() => {
		vi.stubEnv("PI_OFFLINE", "");
		root = mkdtempSync(join(tmpdir(), "pi-npm-links-"));
		agentDir = join(root, "agent");
		callsPath = join(root, "calls.jsonl");
		commandPath = join(root, "npm.mjs");
		writeFileSync(
			commandPath,
			'import { appendFileSync } from "node:fs";\nappendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n");\n',
		);
		settings = SettingsManager.inMemory({ npmCommand: [process.execPath, commandPath, callsPath] });
		settings.setPackages(["npm:test-extension", "npm:other-extension"]);
		settings.setProjectPackages(["npm:test-extension", "npm:other-extension"]);
		manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function directoryLink(target: string, path: string): void {
		symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
	}

	function createPrefix(local: boolean): string {
		const prefix = local ? join(root, ".pi", "npm") : join(agentDir, "npm");
		mkdirSync(prefix, { recursive: true });
		writeFileSync(join(prefix, "package.json"), '{"name":"pi-extensions","private":true}');
		return prefix;
	}

	async function run(operation: Operation, local: boolean): Promise<void> {
		if (operation === "update") {
			// Select only this scope, so the other scope cannot invoke npm during a rejected update.
			if (local) settings.setPackages([]);
			else settings.setProjectPackages([]);
			await manager.update();
		} else {
			await manager[operation]("npm:test-extension", { local });
		}
	}

	for (const local of [false, true]) {
		for (const layout of ["external scope", "external node_modules", "prefix sibling scope"] satisfies Layout[]) {
			it.each(["install", "remove", "update"] satisfies Operation[])(
				`rejects ${layout} before %s in ${local ? "project" : "user"} storage`,
				async (operation) => {
					const prefix = createPrefix(local);
					const modules = join(prefix, "node_modules");
					const host = layout === "prefix sibling scope" ? `${prefix}-host` : join(root, "host");
					const hostScope = join(host, "node_modules", "@example");
					const payload = join(hostScope, "host-app", "cli.js");
					mkdirSync(join(hostScope, "host-app"), { recursive: true });
					writeFileSync(payload, "host payload");
					let link: string;
					let target: string;
					if (layout === "external node_modules") {
						link = modules;
						target = join(host, "node_modules");
					} else {
						mkdirSync(modules);
						link = join(modules, "@example");
						target = hostScope;
					}
					directoryLink(target, link);
					await expect(run(operation, local)).rejects.toThrow("outside managed npm install root");
					expect(existsSync(callsPath)).toBe(false);
					expect(readFileSync(payload, "utf8")).toBe("host payload");
					expect(lstatSync(link).isSymbolicLink()).toBe(true);
					expect(realpathSync(link)).toBe(realpathSync(target));
				},
			);
		}
	}

	it.each(["normal scope", "internal scope link", "package link", "internal node_modules link"])(
		"allows %s",
		async (layout) => {
			const prefix = createPrefix(false);
			const modules = join(prefix, "node_modules");
			if (layout === "internal node_modules link") {
				const target = join(prefix, "modules");
				mkdirSync(target);
				directoryLink(target, modules);
			} else {
				mkdirSync(modules);
				const scope = join(modules, "@example");
				if (layout === "internal scope link") {
					const target = join(modules, ".pnpm", "scope");
					mkdirSync(target, { recursive: true });
					directoryLink(target, scope);
				} else {
					mkdirSync(scope);
					if (layout === "package link") {
						const target = join(root, "linked-package");
						mkdirSync(target);
						directoryLink(target, join(scope, "linked"));
					}
				}
			}
			await run("install", false);
			await run("remove", false);
			await run("update", false);
			const calls = readFileSync(callsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(calls).toHaveLength(3);
			expect(calls.map((args) => args[0])).toEqual(["install", "uninstall", "install"]);
			expect(calls[2]).toContain("other-extension@latest");
		},
	);
});
