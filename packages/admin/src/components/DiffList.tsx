/**
 * Collapsible "N changed rows" list for a diff preview — shared by the CSV import preview
 * (views/Settings.tsx) and the 重新同步此期帳單 modal (views/Payments.tsx).
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
