export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Renders `text` with every occurrence of the shared branch prefix dimmed. */
export function Dimmed({ text, prefix }: { text: string; prefix: string }) {
  if (!prefix || !text.includes(prefix)) return <>{text}</>;
  const parts = text.split(prefix);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && <span className="prefix">{prefix}</span>}
          {part}
        </span>
      ))}
    </>
  );
}
