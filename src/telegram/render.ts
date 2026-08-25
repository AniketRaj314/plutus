const TELEGRAM_MESSAGE_LIMIT = 4096;
const DEFAULT_CHUNK_LIMIT = 3900;
const TABLE_MAX_WIDTH = 72;
const TABLE_MIN_COLUMN_WIDTH = 6;
const TABLE_MAX_COLUMN_WIDTH = 30;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeTelegramTypography(value: string): string {
  return value.replace(/\s*\u2014\s*/g, " - ");
}

function visibleLength(value: string): number {
  return Array.from(value).length;
}

function truncateCell(value: string, width: number): string {
  const chars = Array.from(value);
  if (chars.length <= width) return value;
  if (width <= 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

function padCell(value: string, width: number): string {
  const truncated = truncateCell(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleLength(truncated)))}`;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/\[([^\]]+)]\((?:https?:\/\/)?[^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => stripInlineMarkdown(cell));
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function calculateTableWidths(rows: string[][]): number[] {
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.min(
      TABLE_MAX_COLUMN_WIDTH,
      Math.max(...rows.map((row) => visibleLength(row[column] ?? "")))
    )
  );
  const separators = Math.max(0, columnCount - 1) * 3;

  while (widths.reduce((sum, width) => sum + width, separators) > TABLE_MAX_WIDTH) {
    const widest = widths.reduce(
      (best, width, index) =>
        width > widths[best] && width > TABLE_MIN_COLUMN_WIDTH ? index : best,
      0
    );
    if (widths[widest] <= TABLE_MIN_COLUMN_WIDTH) break;
    widths[widest] -= 1;
  }

  return widths;
}

function renderMarkdownTable(lines: string[]): string {
  const parsed = lines.map(parseTableRow);
  const rows = [parsed[0], ...parsed.slice(2)];
  const widths = calculateTableWidths(rows);
  const renderRow = (row: string[]) =>
    widths.map((width, column) => padCell(row[column] ?? "", width)).join(" │ ");
  const renderedHeader = renderRow(rows[0]);
  const separator = "─".repeat(visibleLength(renderedHeader));
  const body = [renderedHeader, separator, ...rows.slice(1).map(renderRow)].join("\n");
  return `<pre>${escapeHtml(body)}</pre>`;
}

function renderInline(value: string): string {
  const codeTokens: Array<{ token: string; html: string }> = [];
  const linkTokens: Array<{ token: string; html: string }> = [];
  let staged = value.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\uE000CODE${codeTokens.length}\uE001`;
    codeTokens.push({ token, html: `<code>${escapeHtml(code)}</code>` });
    return token;
  });
  staged = staged.replace(
    /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      const token = `\uE000LINK${linkTokens.length}\uE001`;
      linkTokens.push({
        token,
        html: `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
      });
      return token;
    }
  );

  let rendered = escapeHtml(staged)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?;:]|$)/g, "$1<i>$2</i>");

  for (const replacement of [...codeTokens, ...linkTokens]) {
    rendered = rendered.split(replacement.token).join(replacement.html);
  }
  return rendered;
}

function renderRegularLine(line: string): string {
  const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
  if (heading) return `<b>${renderInline(heading[1])}</b>`;

  const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (bullet) return `${bullet[1]}• ${renderInline(bullet[2])}`;

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return `▍ <i>${renderInline(quote[1])}</i>`;

  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return "────────";
  return renderInline(line);
}

function renderBlocks(input: string): string[] {
  const lines = normalizeTelegramTypography(input).replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1])
    ) {
      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      blocks.push(renderMarkdownTable(tableLines));
      continue;
    }

    blocks.push(renderRegularLine(line));
  }

  return blocks;
}

function splitEscapedText(value: string, maxLength: number): string[] {
  const tokens = value.match(/&(?:amp|lt|gt|quot|#39);|./gu) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (current.length + token.length > maxLength && current) {
      chunks.push(current);
      current = "";
    }
    current += token;
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedBlock(block: string, maxLength: number): string[] {
  if (block.length <= maxLength) return [block];
  if (block.startsWith("<pre>") && block.endsWith("</pre>")) {
    const body = block.slice(5, -6);
    const lines = body.split("\n");
    const chunks: string[] = [];
    let current: string[] = [];
    for (const line of lines) {
      const candidate = `<pre>${[...current, line].join("\n")}</pre>`;
      if (candidate.length > maxLength && current.length > 0) {
        chunks.push(`<pre>${current.join("\n")}</pre>`);
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) chunks.push(`<pre>${current.join("\n")}</pre>`);
    return chunks.flatMap((chunk) =>
      chunk.length <= maxLength
        ? [chunk]
        : splitEscapedText(chunk.slice(5, -6), maxLength - 11).map(
            (part) => `<pre>${part}</pre>`
          )
    );
  }

  const plain = block.replace(/<\/?(?:b|i|s|code|a)(?:\s+[^>]*)?>/g, "");
  return splitEscapedText(plain, maxLength);
}

export function renderTelegramHtml(input: string): string {
  return renderBlocks(input).join("\n");
}

export function telegramHtmlToPlainText(input: string): string {
  return input
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderTelegramChunks(
  input: string,
  maxLength = DEFAULT_CHUNK_LIMIT
): string[] {
  if (maxLength <= 0 || maxLength > TELEGRAM_MESSAGE_LIMIT) {
    throw new Error(`Telegram chunk limit must be between 1 and ${TELEGRAM_MESSAGE_LIMIT}`);
  }

  const blocks = renderBlocks(input).flatMap((block) => splitOversizedBlock(block, maxLength));
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}
