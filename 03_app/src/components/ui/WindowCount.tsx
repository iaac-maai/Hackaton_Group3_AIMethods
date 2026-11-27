/**
 * One cell per scored window, with the flagged ones in orange. Only counts are available here (not
 * which windows were flagged), so the flagged cells are grouped first: it shows how many, not when.
 */
export function WindowCount({ total, flagged }: { total: number; flagged: number }) {
  if (!(total > 0)) return null;
  const cells = Array.from({ length: total }, (_, i) => i < flagged);
  return (
    <span className="window-count mo-grow-x" aria-hidden="true" title={`${flagged} of ${total} windows flagged (a count, not their timing)`}>
      {cells.map((on, i) => <span key={i} className={on ? "on" : undefined} />)}
    </span>
  );
}
