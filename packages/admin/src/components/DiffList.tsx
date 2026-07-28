/**
 * Collapsible "N changed rows" list for a diff preview.
 *
 * Deliberately duplicated from the local DiffList inside views/Payments.tsx (the 重新同步本期帳單
 * modal) instead of extracted: that file is being rewritten in a parallel PR, so importing from it
 * would collide. Keep the two visually identical.
 */
export function DiffList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <details style={{ margin: "6px 0" }}>
      <summary style={{ cursor: "pointer" }}>{title}（{rows.length}）</summary>
      <ul style={{ margin: "6px 0 0 18px", color: "var(--muted)", fontSize: 13 }}>
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </details>
  );
}
