package dsh.mcgradle;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.Charset;

/**
 * Minecraft 客户端控制台桥（javaagent premain）。
 *
 * 为什么需要它
 * ------------
 * Gradle 的 JavaExec 把 stdin 转给游戏 JVM 这一步插件已经做到了，但
 * **Minecraft 客户端本身从不读 stdin**：1.20.1 源码全库只有 DedicatedServer
 * 的 "Server console handler" 线程会 readLine，net/minecraft/client/** 零消费者。
 * 所以 runClient 下写进管道的字节没有任何人取走——这就是"提示已发送、游戏没反应"的根因。
 *
 * 这个 agent 在游戏 JVM 里补上缺失的那一端：起一条守护线程读 System.in，
 * 把每行交给客户端主线程执行。全程只用反射，不 import 任何 Minecraft 类，
 * 因此可以脱离模组工程单独编译，也不绑定具体 MC 版本/映射。
 *
 * 找类的办法
 * ----------
 * 不能只用 ClassLoader.getSystemClassLoader()：Forge/NeoForge 的 run 配置把游戏类
 * 交给 FML 的转换类加载器，系统类加载器根本看不见 net.minecraft.client.Minecraft。
 * 这里优先从 Instrumentation.getAllLoadedClasses() 里按名字找（这类问题的唯一可靠来源），
 * 找不到再退回系统/上下文类加载器。类还没被加载时等一会儿再找，而不是直接丢命令。
 *
 * 输入约定
 * --------
 *   - 以 / 开头：当作命令交给 ClientPacketListener.sendCommand（如 /time set day）
 *   - 其它：当作聊天消息交给 sendChat
 *
 * 失败时只打一行 [mc-console] 说明原因，绝不向游戏抛异常。
 */
public final class ConsoleBridge {

    /** 本 agent 的输出前缀，插件按它识别"桥是否活着"。 */
    private static final String TAG = "[mc-console] ";

    /** 固定 UTF-8 输出：MC 项目常见 zh_CN Windows，默认编码是 GBK，中文会乱码。 */
    private static final PrintStream OUT = utf8Out();

    private static final String MC_CLASS = "net.minecraft.client.Minecraft";

    /** 生产名（Mojmap，runClient 用的就是它）与 SRG 名并存。 */
    private static final String[] MC_GET_INSTANCE = { "getInstance", "m_91087_" };
    private static final String[] MC_EXECUTE = { "execute", "m_91388_" };
    private static final String[] LISTENER_GET_CONNECTION = { "getConnection", "m_91403_" };
    private static final String[] SEND_COMMAND = { "sendCommand", "m_241839_" };
    private static final String[] SEND_CHAT = { "sendChat", "m_104948_" };

    private static volatile Instrumentation instrumentation;

    /** 只提示一次"命令在排队等客户端启动"，避免刷屏。 */
    private static volatile boolean warnedWaiting;

    private ConsoleBridge() {
    }

    /** JVM 入口。args 可由 -javaagent:bridge.jar=... 传入，这里不使用。 */
    public static void premain(String args, Instrumentation inst) {
        instrumentation = inst;
        Thread pump = new Thread(new Runnable() {
            @Override
            public void run() {
                readLoop();
            }
        }, "dsh-mc-console");
        pump.setDaemon(true);
        pump.start();
        say("控制台桥已挂上，等待客户端启动");
    }

    private static void readLoop() {
        BufferedReader reader = new BufferedReader(
                new InputStreamReader(System.in, Charset.forName("UTF-8")));
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                String text = line.trim();
                if (text.length() == 0) {
                    continue;
                }
                dispatch(text);
            }
        } catch (Throwable error) {
            say("读取标准输入失败：" + error);
        }
    }

    /** 把一行投到客户端主线程。 */
    private static void dispatch(final String text) {
        final Object minecraft = awaitClient(300000L);
        if (minecraft == null) {
            say("等待客户端启动超时，丢弃：" + text);
            return;
        }
        Method execute = findMethod(minecraft.getClass(), MC_EXECUTE, 1);
        if (execute == null) {
            execute = findMethodByParam(minecraft.getClass(), Runnable.class);
        }
        if (execute == null) {
            say("找不到 Minecraft.execute，无法派发：" + text);
            return;
        }
        final boolean isCommand = text.charAt(0) == '/';
        final String payload = isCommand ? text.substring(1) : text;
        final Method target = execute;
        try {
            target.invoke(minecraft, new Runnable() {
                @Override
                public void run() {
                    deliver(minecraft, payload, isCommand);
                }
            });
        } catch (Throwable error) {
            say("派发失败：" + text + " → " + error);
        }
    }

    /** 在主线程上真正发送（此时读写连接都是安全的）。 */
    private static void deliver(Object minecraft, String payload, boolean isCommand) {
        Object listener;
        try {
            listener = invoke0(minecraft, LISTENER_GET_CONNECTION);
        } catch (Throwable error) {
            say("取连接失败：" + error);
            return;
        }
        if (listener == null) {
            say("尚未进入世界，命令无处执行：" + payload);
            return;
        }
        Method send = findMethod(listener.getClass(), isCommand ? SEND_COMMAND : SEND_CHAT, 1);
        if (send == null) {
            say("找不到发送方法，未执行：" + payload);
            return;
        }
        try {
            send.invoke(listener, payload);
            say("已交给客户端：" + (isCommand ? "/" : "") + payload);
        } catch (Throwable error) {
            say("发送失败：" + payload + " → " + error);
        }
    }

    /**
     * 等 Minecraft 类被加载、实例可拿。
     *
     * 客户端从 premain 到 getInstance() 非空要几十秒，用户很可能在这期间就敲了命令。
     * 直接丢弃体验很差，所以在这里等：读线程等着，后续命令先堆在操作系统管道里。
     */
    private static Object awaitClient(long timeoutMillis) {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        boolean announced = false;
        while (true) {
            Object minecraft = clientInstance();
            if (minecraft != null) {
                return minecraft;
            }
            if (!announced && !warnedWaiting) {
                warnedWaiting = true;
                announced = true;
                say("客户端尚未完成启动，命令先排队");
            }
            if (System.currentTimeMillis() >= deadline) {
                return null;
            }
            try {
                Thread.sleep(100L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
    }

    /** Minecraft.getInstance()，未初始化时返回 null（客户端启动早期是常态）。 */
    private static Object clientInstance() {
        Class<?> type = findMinecraftClass();
        if (type == null) {
            return null;
        }
        try {
            Method instance = findMethod(type, MC_GET_INSTANCE, 0);
            if (instance == null) {
                instance = findStaticFactory(type);
            }
            return instance == null ? null : instance.invoke(null);
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * 找 net.minecraft.client.Minecraft 这个类。
     *
     * 顺序：已加载类表（最可靠，能跨 FML 的转换类加载器）→ 系统类加载器 → 上下文类加载器。
     */
    private static Class<?> findMinecraftClass() {
        Instrumentation inst = instrumentation;
        if (inst != null) {
            Class<?>[] loaded = inst.getAllLoadedClasses();
            if (loaded != null) {
                for (Class<?> candidate : loaded) {
                    if (candidate != null && MC_CLASS.equals(candidate.getName())) {
                        return candidate;
                    }
                }
            }
        }
        ClassLoader[] loaders = {
                ClassLoader.getSystemClassLoader(),
                Thread.currentThread().getContextClassLoader(),
        };
        for (ClassLoader loader : loaders) {
            if (loader == null) {
                continue;
            }
            try {
                return Class.forName(MC_CLASS, false, loader);
            } catch (Throwable ignored) {
                // 换下一个加载器。
            }
        }
        return null;
    }

    private static Object invoke0(Object target, String[] names) throws Exception {
        Method method = findMethod(target.getClass(), names, 0);
        return method == null ? null : method.invoke(target);
    }

    /**
     * 按候选名在类及其父类里找指定参数个数的方法。
     *
     * 遍历父类而不是 getMethod：方法可能声明在父类上，
     * 且混淆环境下真实声明位置不好假定。
     */
    private static Method findMethod(Class<?> type, String[] names, int arity) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getParameterCount() != arity) {
                    continue;
                }
                for (String name : names) {
                    if (!method.getName().equals(name)) {
                        continue;
                    }
                    method.setAccessible(true);
                    return method;
                }
            }
        }
        for (Class<?> face : type.getInterfaces()) {
            Method found = findMethod(face, names, arity);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    /** 名字猜不中时的兜底：找唯一一个接受该参数类型的单参方法（如 execute(Runnable)）。 */
    private static Method findMethodByParam(Class<?> type, Class<?> paramType) {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getParameterCount() != 1 || !paramType.isAssignableFrom(method.getParameterTypes()[0])) {
                    continue;
                }
                method.setAccessible(true);
                return method;
            }
        }
        return null;
    }

    /** 兜底找静态工厂：无参、静态、返回类型就是该类本身（如 getInstance）。 */
    private static Method findStaticFactory(Class<?> type) {
        for (Method method : type.getDeclaredMethods()) {
            if (method.getParameterCount() != 0 || !Modifier.isStatic(method.getModifiers())) {
                continue;
            }
            if (!type.isAssignableFrom(method.getReturnType())) {
                continue;
            }
            method.setAccessible(true);
            return method;
        }
        return null;
    }

    /**
     * 拿一个 UTF-8 的 stdout。
     *
     * 用 FileDescriptor.out 而不是 System.out：后者可能已被游戏/日志框架
     * 重定向到 Log4j，写进去会陷进日志管线里；直接写 fd 才能稳定出现在
     * Gradle 的日志里。构造失败（理论上不会）就退回 System.out。
     */
    private static PrintStream utf8Out() {
        try {
            return new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        } catch (Throwable ignored) {
            return System.out;
        }
    }

    private static void say(String text) {
        OUT.println(TAG + text);
    }
}
