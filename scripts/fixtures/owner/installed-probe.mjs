import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { inspectOwnerArtifact } from "./extension.mjs";
import { runInstalledOwnerContract } from "./installed-contract.mjs";

// The existing faux provider produces one real tool call, with no network or paid API.
export default function (pi) {
	const provider = registerFauxProvider({
		provider: "owner-acceptance",
		models: [{ id: "owner-1", name: "Installed owner acceptance" }],
		tokensPerSecond: 100000,
	});
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("installed_owner_probe", {}, { id: "installed-owner" }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("installed owner acceptance complete"),
	]);
	pi.registerProvider("owner-acceptance", {
		api: provider.api,
		baseUrl: provider.getModel().baseUrl,
		apiKey: "faux-key",
		models: provider.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			inputLimits: model.inputLimits,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	pi.registerTool({
		name: "installed_owner_probe",
		label: "Installed owner acceptance",
		description: "Local deterministic ownership acceptance; never call a remote provider.",
		parameters: Type.Object({}),
		async execute(toolCallId, _args, _signal, _update, context) {
			const embedded = process.platform === "win32" ? "B:/~BUN/root" : "/$bunfs/root";
			let user;
			try {
				user = String(userInfo().uid);
			} catch {
				user = process.env.USER || process.env.USERNAME || "unknown";
			}
			const artifact = inspectOwnerArtifact(embedded, join(tmpdir(), `pi-resources-${user}`));
			if (process.env.PI_PROCWARD_BIN) {
				artifact.developmentNativeOverride = true;
				artifact.developmentOwner = process.env.PI_PROCWARD_BIN;
				artifact.developmentOwnerSha256 = createHash("sha256")
					.update(readFileSync(process.env.PI_PROCWARD_BIN))
					.digest("hex");
			}
			const installed = await runInstalledOwnerContract(context, {
				runtime: process.env.PI_OWNER_RUNTIME,
				fixtures: process.env.PI_OWNER_FIXTURES,
				directory: process.env.PI_OWNER_TASK_DIR,
				toolCallId,
			});
			writeFileSync(process.env.PI_OWNER_PID_FILE, String(installed.survivorPid));
			writeFileSync(
				`${process.env.PI_OWNER_READY}.tmp`,
				JSON.stringify({
					pid: process.pid,
					uid: process.getuid?.() ?? null,
					bun: process.versions.bun ?? null,
					...artifact,
					installed,
				}),
			);
			renameSync(`${process.env.PI_OWNER_READY}.tmp`, process.env.PI_OWNER_READY);
			while (!existsSync(process.env.PI_OWNER_RELEASE)) await delay(10);
			context.shutdown();
			return { content: [{ type: "text", text: "installed owner acceptance complete" }] };
		},
	});
}
