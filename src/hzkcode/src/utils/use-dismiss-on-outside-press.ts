"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/**
 * React Aria's `Popover` couples "non-modal" with "not dismissable on
 * outside interaction" — `isNonModal` (which we set to avoid the scroll
 * lock / focus trap that comes with a modal popover) also silently disables
 * its built-in outside-click-to-close behavior. This restores just that
 * piece manually: closes when a pointerdown lands outside every given ref
 * (typically the trigger + the popover's own content).
 */
export function useDismissOnOutsidePress(
  isOpen: boolean,
  onDismiss: () => void,
  refs: RefObject<HTMLElement | null>[],
) {
  // Call sites pass fresh `() => setIsOpen(false)` closures and fresh
  // `[triggerRef, popoverRef]` arrays every render — keep the latest values
  // in a ref so the listener below attaches/detaches only when `isOpen`
  // actually changes, not on every render while open.
  const latestRef = useRef({ onDismiss, refs });
  useEffect(() => {
    latestRef.current = { onDismiss, refs };
  });

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const { onDismiss, refs } = latestRef.current;
      const target = event.target as Node;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isOpen]);
}

/**
 * 应用内非模态弹层重复的样板：开关状态、触发按钮与弹层引用、外部按压关闭，
 * 以及避免失焦关闭与触发按钮自身切换互相干扰的判定。`setOpen` 直接交给
 * `AriaDialogTrigger.onOpenChange`，`shouldCloseOnInteractOutside` 传给 `Popover`。
 */
export function usePopoverState() {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);

  const close = () => setIsOpen(false);
  const toggle = () => setIsOpen((open) => !open);

  useDismissOnOutsidePress(isOpen, close, [triggerRef, popoverRef]);

  // 按下触发按钮时焦点会先回到按钮，随后才执行按钮自身的按压处理；
  // 把按钮排除在外，失焦关闭不会抢先发生，一次按压只切换一次。
  const shouldCloseOnInteractOutside = (element: Element) =>
    !triggerRef.current?.contains(element);

  return {
    isOpen,
    triggerRef,
    popoverRef,
    toggle,
    close,
    setOpen: setIsOpen,
    shouldCloseOnInteractOutside,
  };
}
