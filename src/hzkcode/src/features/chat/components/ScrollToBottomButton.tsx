import { useCallback, useEffect, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import { IconButton } from "@/components/base/buttons/icon-button";

/** Tail farther out of view than this (px) counts as "away from the bottom". */
const AWAY_THRESHOLD_PX = 100;

/** One-click jump back to the conversation tail (ported from the reference
 * client's ScrollControl, simplified: theirs shows a wheel-direction arrow
 * that auto-hides after 1.5s; here the button persists while the tail is out
 * of view, doubling as a "content below" cue).
 *
 * Self-contained: passive rAF-throttled scroll/resize listeners plus a
 * content-growth signal — appends grow scrollHeight without firing scroll. */
export function ScrollToBottomButton({
  scrollRef,
  contentSignal,
  onJump,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Row count: appends change it without a scroll event. */
  contentSignal: number;
  onJump: () => void;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  const check = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    setVisible(away > AWAY_THRESHOLD_PX);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        check();
      });
    };
    check();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [check, scrollRef]);

  // Appends and late row re-measurements grow scrollHeight silently.
  useEffect(() => {
    check();
  }, [contentSignal, check]);

  if (!visible) return null;

  return (
    <IconButton
      icon={ArrowDown}
      size="small"
      aria-label={t("chat.backToBottom")}
      title={t("chat.backToBottom")}
      onClick={onJump}
      className="absolute right-4 bottom-4 z-10 shadow-dropdown"
    />
  );
}
