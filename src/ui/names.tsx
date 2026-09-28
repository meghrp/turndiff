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
