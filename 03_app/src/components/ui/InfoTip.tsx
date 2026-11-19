import type { ReactNode } from "react";
import { IconInfo } from "./Icons";

/** An info icon that shows the full text in one click. Uses <details>, so it needs no state. */
export function InfoTip({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <details className={`info-tip ${className}`}>
      <summary title={label}>
        <IconInfo />
        <span className="sr-only">{label}</span>
      </summary>
      <div className="info-tip-body">{children}</div>
    </details>
  );
}
