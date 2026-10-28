import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target={href.startsWith("#") ? undefined : "_blank"}
        rel={href.startsWith("#") ? undefined : "noopener noreferrer"}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  table: ({ children }) => (
    <div
      className="ai-markdown-table"
      role="region"
      aria-label="表格，可横向滚动"
      tabIndex={0}
    >
      <table>{children}</table>
    </div>
  ),
  // Model-generated image URLs must not trigger unsolicited remote requests.
  img: ({ alt }) => (
    <span className="ai-markdown-image">[图片：{alt || "未命名"}]</span>
  ),
};

export default memo(function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="ai-message-text ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
