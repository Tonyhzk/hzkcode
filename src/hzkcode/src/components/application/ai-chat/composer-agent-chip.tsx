import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import UserRound from "lucide-react/dist/esm/icons/user-round";

/**
 * 当前会话的基础身份与追加身份，显示在输入框上方；× 发起「切回默认身份」
 * 请求，由 Footer 的共用对话框确认应用方式（不再直接改本地 pin）。
 */
export function SessionIdentityChip({
  name,
  appended,
  onClear,
}: {
  name: string | null;
  appended: string[];
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5 px-1.5">
      <span
        data-testid="session-identity-chip"
        className="inline-flex items-center gap-1 rounded-full bg-background-tertiary-default py-0.5 pl-2 text-caption-1-medium text-text-secondary"
      >
        {name ? (
          <Bot
            aria-hidden
            className="size-3.5 shrink-0 text-foreground-icon-secondary"
          />
        ) : (
          <UserRound
            aria-hidden
            className="size-3.5 shrink-0 text-foreground-icon-secondary"
          />
        )}
        <span className="max-w-48 truncate">
          {name ?? t("chat.sessionIdentityDefault")}
        </span>
        {appended.length > 0 && (
          <span
            className="shrink-0 text-caption-1-regular text-text-tertiary"
            title={appended.join(t("chat.sessionIdentityJoin"))}
          >
            +{appended.length}
          </span>
        )}
        <button
          type="button"
          aria-label={t("chat.sessionIdentityRemove")}
          onClick={onClear}
          className="cursor-pointer rounded-full px-1 hover:text-text-primary"
        >
          ×
        </button>
      </span>
    </div>
  );
}
