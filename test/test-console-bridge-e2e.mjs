// 控制台桥的端到端验收：命令真的从面板那一侧走到「游戏」里。
//
// 这条测试模拟用户报的场景（runClient + 在输入框里敲命令 + 游戏里毫无反应），
// 只把真 Minecraft 换成一个"不读 stdin"的桩：
//   面板管道 → cmd.exe/gradlew → Gradle 9 单次 daemon → JavaExec
//     → 游戏 JVM 的 System.in → javaagent 里的读线程 → 反射调 sendChat/sendCommand
// 桩客户端刻意**不读 System.in**，与真客户端一致（1.20.1 全库 grep 只有
// DedicatedServer 读 stdin）；能收到命令就说明桥补上的正是缺的那一端。
//
// 需要 JDK 17+（javac 由 Gradle 的工具链调用）和可用的 Gradle wrapper：
// fixture 里是 gradle-9.1.0-bin.zip，首次运行会下载到 GRADLE_USER_HOME。
// 没有 JDK 就整体 SKIP，不让纯 JS 环境因为这条用例变红。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { copyWrapper, makeChecker } from "./helpers/fixtures.mjs";
import { bridgePlan, consoleBridgeJar } from "../lib/bridge.js";
import { gradleInvocation } from "../lib/discovery.js";
import { RunRegistry } from "../lib/proc.js";

const { check, finish } = makeChecker();
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

/** 找 javac：先 JAVA_HOME，再看 PATH。找不到返回 undefined。 */
function findJavac() {
	const exe = process.platform === "win32" ? "javac.exe" : "javac";
	const home = process.env.JAVA_HOME;
	if (home !== undefined && existsSync(join(home, "bin", exe))) return join(home, "bin", exe);
	for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
		if (dir.length === 0) continue;
		const candidate = join(dir, exe);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

const jar = consoleBridgeJar(join(repo, "lib"));
if (findJavac() === undefined || jar === undefined) {
	console.log("SKIP — 需要 JDK 17+（javac）与插件自带的 mc-console-bridge.jar");
	process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const root = mkdtempSync(join(tmpdir(), "mc-bridge-e2e-"));
try {
	writeFileSync(join(root, "settings.gradle"), "rootProject.name = 'BridgeE2E'\n");
	writeFileSync(join(root, "gradle.properties"), "org.gradle.jvmargs=-Xmx512m\n");
	writeFileSync(join(root, "build.gradle"), `
plugins { id 'java' }

tasks.register('runClient', JavaExec) {
  classpath = sourceSets.main.runtimeClasspath
  mainClass = 'probe.Client'
}
`);

	// 桩客户端：启动后进入"主循环"，**不读 stdin**。
	const java = (path, body) => {
		const file = join(root, "src", "main", "java", ...path.split("/"));
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
	};
	java("probe/Client.java", `
package probe;

public final class Client {
    public static void main(String[] args) throws Exception {
        net.minecraft.client.Minecraft.boot();
        System.out.println("[client] ready");
        // 真客户端在这里进 GUI 主循环，同样不读 stdin。
        Thread.sleep(60000L);
    }
}
`);
	java("net/minecraft/client/Minecraft.java", `
package net.minecraft.client;

import net.minecraft.client.multiplayer.ClientPacketListener;

public final class Minecraft {
    private static Minecraft instance;
    private final ClientPacketListener listener = new ClientPacketListener();

    public static Minecraft getInstance() { return instance; }
    public static void boot() { instance = new Minecraft(); }
    public void execute(Runnable task) { task.run(); }
    public ClientPacketListener getConnection() { return listener; }
}
`);
	java("net/minecraft/client/multiplayer/ClientPacketListener.java", `
package net.minecraft.client.multiplayer;

public final class ClientPacketListener {
    public void sendChat(String message) { System.out.println("[client] chat:" + message); }
    public void sendCommand(String command) { System.out.println("[client] command:" + command); }
}
`);

	await copyWrapper(root);

	// 用插件自己的判定决定「挂不挂桥」，这样测试验证的是真实接线而不是测试自造的参数。
	const plan = bridgePlan("client", jar);
	check("客户端任务被判为可用", plan.consumer === "stdio", JSON.stringify(plan));
	check("客户端任务会带上桥的环境变量", plan.env !== undefined && plan.env.DSH_MC_CONSOLE_BRIDGE === jar);

	const invocation = gradleInvocation(root);
	const registry = new RunRegistry({ outputLimitBytes: 4 << 20, duplicatePolicy: "allow" });
	const started = registry.start({
		task: "runClient",
		label: "bridge-e2e",
		owner: "owner",
		cwd: invocation.cwd,
		argv: [...invocation.argv, "runClient", "--console=plain", "--no-daemon",
			"-I", join(repo, "lib", "stdin-init.gradle")],
		env: { ...process.env, ...plan.env },
		inputConsumer: plan.consumer,
		inputReason: plan.reason,
	});
	const id = started.job.id;

	/** 轮询输出直到出现 needle（不用固定 sleep：先写会写进已关闭的进程）。 */
	async function waitFor(needle, timeoutMs = 300000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const text = registry.readAll(id, "owner")?.text ?? "";
			if (text.includes(needle)) return text;
			await sleep(200);
		}
		return undefined;
	}

	const ready = await waitFor("[client] ready");
	check("桩客户端启动（构建到 JavaExec 这一段是通的）", ready !== undefined,
		ready === undefined ? (registry.readAll(id, "owner")?.text ?? "").slice(-1500) : "");

	if (ready === undefined) {
		registry.kill(id, "owner", "测试收尾");
		await sleep(3000);
	} else {
		check("桥在游戏 JVM 里挂上了", ready.includes("[mc-console] 控制台桥已挂上"));

		// 关键验收：桩客户端不读 stdin，命令仍然要变成游戏里的动作。
		registry.write(id, "owner", "hello from panel");
		const chat = await waitFor("[client] chat:hello from panel", 60000);
		check("普通文本变成聊天消息", chat !== undefined,
			chat === undefined ? "超时未见 chat" : "已看到 chat");

		registry.write(id, "owner", "/time set day");
		const command = await waitFor("[client] command:time set day", 60000);
		check("/开头的内容变成游戏指令", command !== undefined,
			command === undefined ? "超时未见 command" : "已看到 command");

		const ack = await waitFor("[mc-console] 已交给客户端：hello from panel", 5000);
		check("桥会打印送达回执（面板据此告诉用户真的到了）", ack !== undefined);

		registry.kill(id, "owner", "测试收尾");
		await sleep(3000);
	}
	registry.dispose();
} finally {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(root, { recursive: true, force: true });
			break;
		} catch {
			await sleep(400);
		}
	}
}

process.exit(finish("CONSOLE BRIDGE E2E TESTS"));
