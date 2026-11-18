import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FiAlertCircle, FiCheck, FiCopy, FiLoader } from "react-icons/fi";

export type CopyStatus = "idle" | "pending" | "success" | "error";
const words = {
  zh: { pending: "复制中…", success: "已复制到剪贴板", copied: "已复制", error: "复制失败，请重试或手动复制。" },
  en: { pending: "Copying…", success: "Copied to clipboard", copied: "Copied", error: "Copy failed. Retry or copy manually." },
};
type Lang = keyof typeof words;

export function useCopyText(text?: string, scope?: unknown) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const generation = useRef(0), busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reset = useCallback(() => {
    generation.current++;
    busy.current = false;
    clearTimeout(timer.current);
    setStatus("idle");
  }, []);
  useLayoutEffect(() => {
    reset();
    return () => { generation.current++; busy.current = false; clearTimeout(timer.current); };
  }, [text, scope, reset]);
  const copy = useCallback(async (value = text) => {
    if (busy.current) return false;
    busy.current = true;
    const current = ++generation.current;
    clearTimeout(timer.current);
    setStatus("pending");
    let result: CopyStatus = "success";
    try {
      if (value === undefined || !navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
    } catch { result = "error"; }
    if (current !== generation.current) return false;
    busy.current = false;
    setStatus(result);
    if (result === "success") timer.current = setTimeout(() => { if (current === generation.current) setStatus("idle"); }, 2400);
    return result === "success";
  }, [text]);
  return { status, pending: status === "pending", copy, reset };
}

export function CopyIcon({ status, ...props }: ComponentProps<typeof FiCopy> & { status: CopyStatus }) {
  const Icon = status === "pending" ? FiLoader : status === "success" ? FiCheck : status === "error" ? FiAlertCircle : FiCopy;
  return <Icon {...props} aria-hidden className={[props.className, status === "pending" ? "animate-spin" : ""].filter(Boolean).join(" ")} />;
}

export function CopyFeedback({ status, anchor, lang, id }: { id?: string; status: CopyStatus; anchor: RefObject<HTMLButtonElement | null>; lang: Lang }) {
  const visible = status === "pending" || status === "error";
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const feedback = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPosition({
        top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - (feedback.current?.offsetHeight ?? 40) - 8)),
        right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - (feedback.current?.offsetWidth ?? 0) - 8)),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [visible, status, anchor, lang]);
  return createPortal(<div id={id} ref={feedback} role="status" aria-live="polite" aria-atomic="true" data-copy-feedback data-status={status}
    style={visible ? {
      position: "fixed", zIndex: 10001, ...position, width: "max-content", maxWidth: "calc(100vw - 16px)", padding: "8px 11px", border: "1px solid #24231f24", borderRadius: 7,
      background: status === "error" ? "var(--color-nb-peach-soft, #fff0e8)" : "var(--color-nb-mint-soft, #e9f5ee)",
      color: status === "error" ? "var(--color-nb-peach-ink, #843b24)" : "var(--color-nb-mint-ink, #26563e)",
      boxShadow: "0 3px 10px #24231f16", font: "600 12px var(--font-sans, sans-serif)", pointerEvents: "none",
    } : { position: "fixed", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)" }}>{status === "idle" ? "" : words[lang][status]}</div>, document.body);
}

type CopyButtonProps = Omit<ComponentProps<"button">, "onClick" | "children"> & {
  text?: string; label: string; lang: Lang; scope?: unknown; showLabel?: boolean; manual?: boolean; iconSize?: number; onCopied?: () => void;
};
export function CopyButton({ text, label, lang, scope, showLabel, manual, iconSize = 12, onCopied, disabled, ...props }: CopyButtonProps) {
  const { status, pending, copy } = useCopyText(text, scope);
  const anchor = useRef<HTMLButtonElement>(null);
  const feedbackId = useId();
  const title = status === "success" ? undefined : status === "idle" ? label : words[lang][status];
  return <>
    <button {...props} ref={anchor} type="button" aria-label={label} title={title} disabled={disabled || text === undefined || pending} aria-busy={pending} aria-describedby={feedbackId} data-copy-button data-status={status} onClick={() => { void copy().then(ok => { if (ok) onCopied?.(); }); }}>
      <CopyIcon status={status} size={iconSize} />{showLabel && (status === "success" ? words[lang].copied : status === "pending" ? words[lang].pending : label)}
    </button>
    <CopyFeedback id={feedbackId} status={status} anchor={anchor} lang={lang} />
    {manual && status === "error" && <textarea readOnly aria-label={label} value={text} onFocus={e => e.currentTarget.select()} className="mt-2 w-full rounded border p-2 text-[13px]" />}
  </>;
}
