// 控制台输入的判定层回归测试。
//
// 背景（实测）：Minecraft 1.20.1 源码全库 grep `System.in` 只有一处真命中，
// 在 net/minecraft/server/dedicated/DedicatedServer.java 的 "Server console handler"
// 线程里；net/minecraft/client/** 下没有任何一处读 stdin。
// 也就是说 runClient 下字节到了 JVM 也没有消费者——面板早先照样提示
// 「已发送到游戏控制台」是谎报。
//
// 因此「能不能发」被拆成一个显式判定（lib/bridge.js 的 bridgePlan）：
//   - server：Forge 的 JLine 已经在读 → stdio，不挂桥；
//   - client：必须挂 javaagent 补上读者 → 有 jar 才可用，缺 jar 明确禁用；
//   - data：批处理 → none；
//   - 关掉 forwardStdin：连转发都没有 → none。
// 写入口（proc.write）与面板（client.js）都照这个字段裁决。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { RunRegistry, publicView } from "../lib/proc.js";
import { BRIDGE_ENV, bridgePlan, consoleBridgeJar } from "../lib/bridge.js";

let failures = 0;
function check(label, condition, extra) {
	if (condition) {
		console.log(`[PASS] ${label}${extra === undefined ? "" : ` — ${extra}`}`);
		return;
	}
	failures += 1;
	console.error(`[FAIL] ${label}${extra === undefined ? "" : ` — ${extra}`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_JAR = "C:/nonexistent/mc-console-bridge.jar";

// ---- 判定层：哪种任务算「有人读 stdin」 ----
const serverPlan = bridgePlan("server", FAKE_JAR);
check("服务端不挂桥（Forge 的 JLine 已经在读同一个 stdin，两个读者会抢行）",
	serverPlan.consumer === "stdio" && serverPlan.env === undefined, JSON.stringify(serverPlan));

const clientNoJar = bridgePlan("client", undefined);
check("客户端缺 jar 时明确禁用，而不是假装能发",
	clientNoJar.consumer === "none" && typeof clientNoJar.reason === "string", JSON.stringify(clientNoJar));
check("缺 jar 的原因指出要补的东西与补救动作",
	clientNoJar.reason.includes("mc-console-bridge.jar") && clientNoJar.reason.includes("build.mjs"),
	clientNoJar.reason);

const clientWithJar = bridgePlan("client", FAKE_JAR);
check("客户端有 jar 时可用（agent 会在游戏 JVM 里补上读者）",
	clientWithJar.consumer === "stdio" && clientWithJar.env?.[BRIDGE_ENV] === FAKE_JAR,
	JSON.stringify(clientWithJar));

const dataPlan = bridgePlan("data", FAKE_JAR);
check("数据生成是批处理，判为无消费者",
	dataPlan.consumer === "none" && dataPlan.reason.includes("批处理"), JSON.stringify(dataPlan));

check("未知 run* 任务按「可能有人读」处理，不误禁用",
	bridgePlan("other", FAKE_JAR).consumer === "stdio");

const noForward = bridgePlan("client", FAKE_JAR, false);
check("关掉 forwardStdin 时即使有 jar 也不能发（没有 -I 就没有转发）",
	noForward.consumer === "none" && noForward.reason.includes("forwardStdin"), JSON.stringify(noForward));

// 插件自带 jar 必须真的在仓库里，否则发布后 agent 静默失效。
const jarPath = consoleBridgeJar();
check("仓库里存在自带 jar", jarPath !== undefined && existsSync(jarPath), String(jarPath));
check("jar 缺失时 consoleBridgeJar 返回 undefined（不能返回假路径去挂 agent）",
	consoleBridgeJar(join(here, "definitely-missing")) === undefined);

// ---- 写入口：canInput 与 write 必须一致 ----
const CHILD = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line === "quit") { console.log("BYE"); process.exit(0); }
		if (line !== "") console.log("ECHO " + line);
	}
});
console.log("READY");
`;

const registry = new RunRegistry({ outputLimitBytes: 1 << 20, duplicatePolicy: "allow" });

function startJob(plan) {
	return registry.start({
		task: plan.consumer === "none" ? "runClient" : "runServer",
		label: `stdin-${plan.consumer}`,
		owner: "owner",
		cwd: process.cwd(),
		argv: [process.execPath, "--input-type=module", "-e", CHILD],
		inputConsumer: plan.consumer,
		inputReason: plan.reason,
	}).job.id;
}

const serverId = startJob(serverPlan);
await sleep(400);
const serverView = publicView(registry.require(serverId, "owner"));
check("读 stdin 的任务 canInput 为 true", serverView.canInput === true, String(serverView.canInput));
check("读 stdin 的任务不额外给出 inputReason", serverView.inputReason === undefined, String(serverView.inputReason));
registry.write(serverId, "owner", "ping");
await sleep(400);
const serverOutput = registry.require(serverId, "owner").output;
check("写进管道的内容真的被子进程收到", serverOutput.includes("ECHO ping"), serverOutput.trim());
registry.write(serverId, "owner", "quit");
await sleep(400);

const clientId = startJob(clientNoJar);
await sleep(400);
const clientView = publicView(registry.require(clientId, "owner"));
check("无消费者的任务 canInput 为 false", clientView.canInput === false, String(clientView.canInput));
check("canInput 为 false 时带上可直接展示的原因",
	typeof clientView.inputReason === "string" && clientView.inputReason.includes("标准输入"), clientView.inputReason);

let rejected;
try {
	registry.write(clientId, "owner", "list");
	rejected = { delivered: true };
} catch (error) {
	rejected = { message: error.message, code: error.code };
}
check("write 在写入前拒绝（不先把命令丢进管道再谎报成功）",
	rejected.delivered === undefined && typeof rejected.message === "string", JSON.stringify(rejected));
check("拒绝时带上 INPUT_UNSUPPORTED 便于路由层回传",
	rejected.code === "INPUT_UNSUPPORTED", String(rejected.code));

const legacyId = registry.start({
	task: "runServer", label: "legacy", owner: "owner", cwd: process.cwd(),
	argv: [process.execPath, "--input-type=module", "-e", CHILD],
}).job.id;
await sleep(400);
check("未声明 inputConsumer 时默认按 stdio（默认值与旧行为一致）",
	publicView(registry.require(legacyId, "owner")).canInput === true);

registry.dispose();

// ---- 源码级契约：接线必须真的存在 ----
const hostSource = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const initScript = readFileSync(join(here, "..", "lib", "stdin-init.gradle"), "utf8");

check("主机用 bridgePlan 判定并带上 forwarding 状态",
	/const plan = bridgePlan\(target\.kind, consoleBridgeJar\(\)/.test(hostSource));
check("主机把判定结果传给注册表",
	hostSource.includes("inputConsumer: plan.consumer") && hostSource.includes("inputReason: plan.reason"));
check("主机会给客户端子进程注入桥的环境变量",
	hostSource.includes("env: plan.env === undefined ? undefined : { ...process.env, ...plan.env }"));
check("forwardStdin 有被纳入 forwarding 判定", hostSource.includes("const forwarding = config.forwardStdin !== false"));
check("init 脚本读取该环境变量", initScript.includes("DSH_MC_CONSOLE_BRIDGE"));
check("init 脚本只在客户端任务上挂 agent（避免与服务端 JLine 抢行）",
	/-javaagent:/.test(initScript) && /isClientTask/.test(initScript));
check("面板不再只看 isLive 决定可输入",
	clientSource.includes("const canInput = isLive && selected?.canInput === true;"));
check("输入框 disabled 绑定 canInput", clientSource.includes("disabled: !canInput"));
check("placeholder 在不可输入时显示原因",
	clientSource.includes("(inputReason ?? \"任务已结束，无法发送命令\")"));
check("发送按钮同样绑定 canInput",
	clientSource.includes("disabled: !canInput || input.trim().length === 0"));

if (failures > 0) {
	console.error(`\n${failures} 个测试失败`);
	process.exit(1);
}
console.log("\nALL INPUT GATE TESTS PASSED");
