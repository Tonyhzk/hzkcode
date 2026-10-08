import { commandRegistry } from "@hzkcode/plugin-sdk";
import { listenSettingsChanged } from "@/lib/events";
import { resolveShortcut, shortcutActions } from "./actions";
import { registerKeydownHandler } from "./dispatcher";
import {
  isEditableShortcutTarget,
  matchesShortcutForPlatform,
  parseShortcut,
} from "./shortcuts";
import { useShortcutsStore } from "./store";

/**
 * 快捷键绑定运行时。startShortcutRuntime() 在 App 挂载时调用一次：
 * 向全局 dispatcher 注册一个 handler，按键时按 shortcutActions 表序匹配
 * 有效键位（设置值优先，缺省回退默认），命中后执行该动作已注册的组件
 * handler，无组件 handler 时运行其 commandRegistry 命令。
 */

export type ShortcutHandler = () => void;

const handlers = new Map<string, Set<ShortcutHandler>>();

/** 组件作用域动作在此注册回调（终端、侧栏搜索、编辑器保存等）。
 *  同一动作可有多个注册者（如每个编辑器实例），全部调用、各自自检。 */
export function registerShortcutHandler(
  actionId: string,
  handler: ShortcutHandler,
): () => void {
  let set = handlers.get(actionId);
  if (!set) {
    set = new Set();
    handlers.set(actionId, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(actionId);
  };
}

let started = false;

/** 带主修饰键（cmd/ctrl/alt）的绑定在编辑区让位：这类组合多与系统或
 *  编辑操作重合（如自定义为 ⌃C 时的复制），裸键（如默认的 Esc）不受限。 */
function hasPrimaryModifier(value: string): boolean {
  const parsed = parseShortcut(value);
  return Boolean(parsed && (parsed.meta || parsed.ctrl || parsed.alt));
}

/** 有效键位是恰好一个裸 Esc（无任何修饰键）。 */
function isBareEscape(value: string): boolean {
  const parsed = parseShortcut(value);
  return Boolean(
    parsed &&
      parsed.key === "escape" &&
      !parsed.meta &&
      !parsed.ctrl &&
      !parsed.alt &&
      !parsed.shift,
  );
}

export function startShortcutRuntime(): () => void {
  if (started) return () => {};
  started = true;

  void useShortcutsStore.getState().reload();
  let cancelled = false;
  let unlistenSettings: (() => void) | undefined;
  void listenSettingsChanged(() => void useShortcutsStore.getState().reload()).then(
    (unlisten) => {
      if (cancelled) unlisten();
      else unlistenSettings = unlisten;
    },
  );

  const unregisterKeydown = registerKeydownHandler((event) => {
    const values = useShortcutsStore.getState().values;
    for (const action of shortcutActions) {
      const value = resolveShortcut(action, values);
      if (!value) continue;
      if (event.repeat && !action.allowRepeat) continue;
      if (
        action.editableGuard &&
        hasPrimaryModifier(value) &&
        (isEditableShortcutTarget(event.target) ||
          isEditableShortcutTarget(document.activeElement))
      ) {
        continue;
      }
      if (!matchesShortcutForPlatform(event, value)) continue;
      const local = handlers.get(action.id);
      const command = action.commandId
        ? commandRegistry.get(action.commandId)
        : undefined;
      if (!local && !command) continue;
      const run = () => {
        if (local) {
          for (const handler of Array.from(local)) handler();
        } else {
          command?.run();
        }
      };
      // 裸 Esc 同时是全局「关闭/取消」键：命令面板、文件搜索、运行状态
      // 面板等都挂在 window 上且晚于本 dispatcher 注册，同一轮 keydown
      // 里本 handler 先跑、看不到它们稍后的 preventDefault。把触发推迟
      // 到下一任务轮（微任务可能在两个监听器之间就被执行）再确认，
      // 只有无人消费时才执行（如中断对话）。
      if (isBareEscape(value)) {
        // 输入法候选窗未上屏时 Esc 属于 IME，不触发
        if (event.isComposing || event.keyCode === 229) return;
        setTimeout(() => {
          if (!event.defaultPrevented) run();
        }, 0);
        return;
      }
      event.preventDefault();
      run();
      return;
    }
  });

  return () => {
    cancelled = true;
    unlistenSettings?.();
    unregisterKeydown();
    started = false;
  };
}
