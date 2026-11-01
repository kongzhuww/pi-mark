// @ts-nocheck
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";

export interface MarkedSession {
  id: string;
  path: string;
  title: string;
  profile: string;
  command: string;
  resume_cmd: string;
  cwd: string;
  created_at: number;
  updated_at: number;
}

function getHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getMarkedSessionsPath(): string {
  return path.join(getHomeDir(), ".pi", "agent", "marked-sessions.json");
}

function readMarkedSessions(): MarkedSession[] {
  const filePath = getMarkedSessionsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) || [];
  } catch {
    return [];
  }
}

function writeMarkedSessions(sessions: MarkedSession[]): void {
  const filePath = getMarkedSessionsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(sessions, null, 2), "utf-8");
}

function getProfileName(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || "";
  const m = dir.match(/profiles[\\/]([^\\/]+)/i);
  if (m) return m[1];
  if (/[\/\\]\.pi[\/\\]agent$/i.test(dir) || dir.endsWith("agent")) return "agent";
  return "agent";
}

function getProfileCommand(profile: string): string {
  const profileCommands: Record<string, string> = {
    agent: "pi-1",
    eigenflux: "pi-2",
    platform: "pi-3",
    reverse: "pi-4",
    cad: "pi-5",
    video: "pi-6",
    career: "pi-7",
  };
  return profileCommands[profile] || "pi";
}

function sendHerdrNotification(title: string, body: string): void {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !socketPath) return;

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  const request = {
    id: `mark:${Date.now()}`,
    method: "notification.show",
    params: {
      title,
      body,
    },
  };

  try {
    const socket = net.createConnection(socketEndpoint);
    socket.on("error", () => {});
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      setTimeout(() => socket.destroy(), 300);
    });
  } catch {}
}

function extractFirstMessageTitle(entries: any[]): string {
  if (!Array.isArray(entries)) return "未命名会话";
  for (const entry of entries) {
    if (entry?.type === "message" && entry?.message?.role === "user") {
      let text = "";
      if (typeof entry.message.content === "string") {
        text = entry.message.content;
      } else if (Array.isArray(entry.message.content)) {
        for (const part of entry.message.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
      const line = text.trim().replace(/^[\r\n\s]+/, "").split(/\r?\n/)[0];
      if (line) {
        return line.slice(0, 30);
      }
    }
  }
  return "未命名会话";
}

export default function sessionMarkerExtension(pi: ExtensionAPI) {
  pi.registerCommand("mark", {
    description: "标记当前会话为喜欢的对话，同步记录在 Herdr 侧边栏和 /resume 中",
    getArgumentCompletions: (prefix) => {
      const options = [
        { value: "list", label: "list — 查看所有已标记的喜欢的对话" },
      ];
      return options.filter((o) => o.value.startsWith(prefix));
    },
    handler: async (args, ctx: ExtensionContext) => {
      const trimmedArgs = (args || "").trim();

      if (trimmedArgs === "list") {
        const sessions = readMarkedSessions();
        if (sessions.length === 0) {
          ctx.ui.notify("暂无任何标记的喜欢的对话。在任意会话输入 /mark 即可标记。", "info");
          return;
        }
        let listText = `已标记的喜欢的对话 (${sessions.length} 个):\n`;
        sessions.forEach((s, idx) => {
          listText += `  ${idx + 1}. [${s.profile}] ${s.title}\n     命令: ${s.resume_cmd}\n`;
        });
        if (ctx.hasUI) {
          ctx.ui.notify(listText, "info");
        } else {
          console.log(listText);
        }
        return;
      }

      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionId = ctx.sessionManager?.getSessionId?.();

      if (!sessionFile) {
        ctx.ui.notify("无法获取当前会话文件路径，会话可能未保存。", "warning");
        return;
      }

      let title = trimmedArgs;
      if (!title) {
        let currentName = pi.getSessionName() || ctx.sessionManager?.getSessionName?.() || "";
        if (currentName.startsWith("★ ")) {
          currentName = currentName.slice(2).trim();
        }
        if (currentName) {
          title = currentName;
        } else {
          title = extractFirstMessageTitle(ctx.sessionManager?.getEntries?.() || []);
        }
      }

      const profile = getProfileName();
      const command = getProfileCommand(profile);
      const resume_cmd = `${command} --resume "${sessionFile}"`;
      const cwd = ctx.cwd || process.cwd();
      const now = Date.now();

      const sessions = readMarkedSessions();
      const existingIdx = sessions.findIndex(
        (s) => s.id === sessionId || s.path === sessionFile
      );

      const entry: MarkedSession = {
        id: sessionId || path.basename(sessionFile, ".json"),
        path: sessionFile,
        title,
        profile,
        command,
        resume_cmd,
        cwd,
        created_at: existingIdx >= 0 ? sessions[existingIdx].created_at : now,
        updated_at: now,
      };

      if (existingIdx >= 0) {
        sessions[existingIdx] = entry;
      } else {
        sessions.push(entry);
      }

      writeMarkedSessions(sessions);

      try {
        pi.setSessionName(`★ ${title}`);
      } catch {}

      sendHerdrNotification("会话已标记", `[${profile}] ${title} 已加入 Herdr 喜欢的对话`);

      ctx.ui.notify(
        `★ 已将该会话标记为喜欢的对话！\n可在 Herdr 侧边栏下半部分直接点击恢复，亦可在 /resume 中搜 ★ 找到。`,
        "info"
      );
    },
  });

  pi.registerCommand("unmark", {
    description: "取消当前会话的标记，从 Herdr 喜欢的对话中移除",
    handler: async (_args, ctx: ExtensionContext) => {
      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const sessionId = ctx.sessionManager?.getSessionId?.();

      const sessions = readMarkedSessions();
      const initialLen = sessions.length;
      const nextSessions = sessions.filter(
        (s) => s.id !== sessionId && s.path !== sessionFile
      );

      if (nextSessions.length === initialLen) {
        ctx.ui.notify("当前会话未被标记，无需取消。", "info");
        return;
      }

      writeMarkedSessions(nextSessions);

      try {
        let currentName = pi.getSessionName() || ctx.sessionManager?.getSessionName?.() || "";
        if (currentName.startsWith("★ ")) {
          currentName = currentName.slice(2).trim();
          pi.setSessionName(currentName);
        }
      } catch {}

      sendHerdrNotification("会话已取消标记", "已从 Herdr 喜欢的对话中移除");

      ctx.ui.notify("已取消标记此会话，不再继续跟踪，已从 Herdr 喜欢的对话中移除。", "info");
    },
  });
}
