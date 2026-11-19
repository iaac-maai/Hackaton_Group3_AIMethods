import { useEffect, useRef, useState } from "react";

// The 3D evaluation graphs are a self-contained page in public/graphs/ (canvas, no dependencies).
// It posts its content height so the iframe can grow without an inner scrollbar.
const SRC = "/graphs/index.html?embed=1&bg=transparent";

export function ModelEvaluation() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1600);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; height?: number } | null;
      if (d?.type === "motion-atlas:height" && typeof d.height === "number" && d.height > 0) setHeight(Math.ceil(d.height));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <section className="model-eval" aria-label="Model evaluation">
      <iframe ref={frame} src={SRC} title="Motion Atlas model evaluation: interactive 3D graphs"
        style={{ height }} loading="lazy" />
    </section>
  );
}
