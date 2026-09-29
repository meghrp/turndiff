import { useMemo } from "react";
import { Marked, type RendererObject } from "marked";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Guide text comes from an agent, and this page can submit reviews through its
// own API: raw HTML is shown as text and links only go to http(s) or mail.
const renderer: RendererObject = {
  html: ({ text }) => escape(text),
  image: ({ text }) => escape(text),
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    if (!/^(https?:|mailto:)/i.test(href)) return label;
    return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""} target="_blank" rel="noopener noreferrer">${label}</a>`;
  },
};
const marked = new Marked({ gfm: true, async: false, renderer });

export const renderMarkdown = (text: string, inline = false) => (inline ? marked.parseInline(text) : marked.parse(text)) as string;

export function Markdown({ text, inline = false, className = "" }: { text: string; inline?: boolean; className?: string }) {
  const html = useMemo(() => renderMarkdown(text, inline), [text, inline]);
  const Tag = inline ? "span" : "div";
  return <Tag className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
