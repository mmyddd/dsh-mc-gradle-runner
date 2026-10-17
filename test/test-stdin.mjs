// 交互式 stdin 的回归测试：runClient 这类任务必须能把控制台指令送进子进程。
//
// 为什么需要一个真进程：`registry.write()` 的正确性完全取决于
// `spawn(..., { stdio: ['pipe', ...] })` 与子进程真的在读 stdin。用假子进程
// 只能测到「我调用了 write」，测不到「游戏收到了指令」。
//
// 用一个读一行、回一行的 node 子进程代替 MC client：行为足够等价，且不依赖 Gradle。
import { spawn } from "node:child_process";
import process from "node:process";

import { RunRegistry } from "../lib/proc.js";

let failures = 0;
function check(label, condition, extra) {
	if (condition) {
		console.log(`[PASS] ${label}${extra === undefined ? "" : ` — ${extra}`}`);
		return;
	}
	failures += 1;
	console.error(`[FAIL] ${label}${extra === undefined ? "" : ` — ${extra}`}`);
}

/** 子进程：从 stdin 逐行读，回显 `ECHO <行>`，读到 "quit" 就退出。 */
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等某个字符串出现在输出里，或超时。 */
async function waitFor(registry, id, needle, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const job = registry.readAll(id, "owner");
		if (job?.text?.includes(needle) === true) return job.text;
		await sleep(40);
	}
	return undefined;
}

const registry = new RunRegistry({ outputLimitBytes: 1 << 20, duplicatePolicy: "allow" });

const started = registry.start({
	task: "runClient",
	label: "stdin 交互测试",
	owner: "owner",
	cwd: process.cwd(),
	argv: [process.execPath, "--input-type=module", "-e", CHILD],
	// 子进程要立刻 flush 输出：env 里关掉 node 的缓冲。
	env: { ...process.env, NODE_OPTIONS: "" },
});

check("任务已创建", typeof started?.job?.id === "string", started?.job?.id);
const id = started.job.id;

const ready = await waitFor(registry, id, "READY");
check("子进程启动并能读到 stdout", ready !== undefined);

// ---- 关键验收点：write() 真的送到子进程 ----
registry.write(id, "owner", "say hello");
const echoed = await waitFor(registry, id, "ECHO say hello");
check("registry.write 把一行送到子进程 stdin", echoed !== undefined,
	echoed === undefined ? "超时未见 ECHO" : "已看到 ECHO");

// 不带换行的输入也要能送达（补换行是 write 的职责）。
registry.write(id, "owner", "second");
const echoed2 = await waitFor(registry, id, "ECHO second");
check("write 自动补换行", echoed2 !== undefined);

// ---- 越权与失败路径 ----
let denied = false;
try {
	registry.write(id, "another-owner", "nope");
} catch (error) {
	denied = true;
}
check("别的 owner 不能写同一个任务的 stdin", denied);

let missing = false;
try {
	registry.write("no-such-job", "owner", "nope");
} catch (error) {
	missing = true;
}
check("对不存在的任务 write 会抛错", missing);

// ---- 子进程主动退出后 write 不能炸掉调用方 ----
registry.write(id, "owner", "quit");
const bye = await waitFor(registry, id, "BYE");
check("quit 让子进程正常退出", bye !== undefined);

await sleep(300);
// 已结算后 write 抛错是**有意的**契约：调用方（面板）据此提示"任务已结束"，
// 而不是静默丢弃用户输入。
let writeAfterExit;
try {
	registry.write(id, "owner", "too late");
	writeAfterExit = { delivered: true };
} catch (error) {
	writeAfterExit = { error: error.message };
}
check("进程退出后 write 明确报错（面板据此提示）",
	typeof writeAfterExit.error === "string" && writeAfterExit.error.includes("已结束"), JSON.stringify(writeAfterExit));

registry.dispose();

if (failures > 0) {
	console.error(`\n${failures} 个测试失败`);
	process.exit(1);
}
console.log("\nALL STDIN TESTS PASSED");
