import { create } from "zustand";
import type { SessionIdentityOption } from "@/features/chat/session-control-view";

/**
 * # 身份选择与 chip 清空产生的待应用身份请求。会话控制对话框由
 * ConversationFooter 统一渲染，避免 composer 直接发起 IPC。
 */
export interface PendingIdentityRequest {
  /** 发起请求的会话（sessionKey）；切换会话后仍绑定原会话。 */
  key: string;
  identity: SessionIdentityOption;
}

interface PendingIdentityState {
  request: PendingIdentityRequest | null;
  requestIdentity: (key: string, identity: SessionIdentityOption) => void;
  /** 关闭请求；传 key 时只清理该会话自己的请求。 */
  clear: (key?: string) => void;
}

export const usePendingIdentityStore = create<PendingIdentityState>((set) => ({
  request: null,
  requestIdentity: (key, identity) => set({ request: { key, identity } }),
  clear: (key) =>
    set((state) =>
      key && state.request?.key !== key ? state : { request: null },
    ),
}));
