function keyPath(text) {
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > 0) {
    const match = /^("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)/.exec(remaining);
    if (!match) throw new Error("Global config contains an unsupported TOML key.");
    const token = match[0];
    parts.push(token.startsWith('"') ? JSON.parse(token.replace(/\\U([0-9a-fA-F]{8})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))) : token.startsWith("'") ? token.slice(1, -1) : token);
    remaining = remaining.slice(token.length).trim();
    if (remaining.length === 0) break;
    if (!remaining.startsWith(".")) throw new Error("Global config contains an ambiguous TOML key.");
    remaining = remaining.slice(1).trim();
    if (remaining.length === 0) throw new Error("Global config contains an incomplete TOML key.");
  }
  return parts;
}

export function tomlStatements(lines) {
  const statements = [];
  let table = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() === "") continue;
    if (lines[start].trimStart().startsWith("#")) {
      statements.push({ kind: "comment", start, end: start, table: [...table] });
      continue;
    }
    let quote = null;
    let multiline = false;
    let escaped = false;
    let depth = 0;
    let text = "";
    let equals = -1;
    let comment = "";
    let end = start;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      for (let i = 0; i < line.length; i += 1) {
        const character = line[i];
        if (quote !== null) {
          text += character;
          if (escaped) { escaped = false; continue; }
          if (quote === '"' && character === "\\") { escaped = true; continue; }
          if (character === quote) {
            if (!multiline) quote = null;
            else if (line.slice(i, i + 3) === quote.repeat(3)) {
              let length = 3;
              while (length < 5 && line[i + length] === quote) length += 1;
              text += line.slice(i + 1, i + length);
              i += length - 1;
              quote = null;
              multiline = false;
            }
          }
          continue;
        }
        if (character === "#") { comment = line.slice(i); break; }
        if (character === '"' || character === "'") {
          quote = character;
          multiline = line.slice(i, i + 3) === character.repeat(3);
          if (multiline) { text += character.repeat(2); i += 2; }
        } else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === "=" && equals === -1) equals = text.length;
        text += character;
      }
      if (quote !== null && !multiline) throw new Error("Global config contains an unterminated TOML string.");
      if (quote === null && depth === 0) break;
      if (depth < 0) throw new Error("Global config contains unbalanced TOML delimiters.");
      text += "\n";
      escaped = false;
    }
    if (end >= lines.length) throw new Error("Global config contains an incomplete TOML statement.");
    const trimmed = text.trim();
    if (trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const bracket = array ? 2 : 1;
      table = keyPath(trimmed.slice(bracket, -bracket));
      statements.push({ kind: array ? "arrayTable" : "table", path: table, start, end, comment });
    } else {
      if (equals < 0) throw new Error("Global config contains an invalid TOML assignment.");
      const key = keyPath(text.slice(0, equals));
      statements.push({ kind: "key", path: [...table, ...key], key, table: [...table], start, end, comment });
    }
    start = end;
  }
  return statements;
}

const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const prefix = (first, second) => first.length <= second.length && first.every((part, index) => part === second[index]);

export function setTomlValues(lines, tableName, values) {
  const table = tableName === "" ? [] : tableName.split(".");
  const statements = tomlStatements(lines);
  const headers = statements.filter((entry) => entry.kind === "table" && same(entry.path, table));
  if (headers.length > 1) throw new Error(`Global config contains duplicate [${tableName}] sections.`);
  const replacements = [];
  const missing = [];
  for (const [key, value] of Object.entries(values)) {
    const target = [...table, key];
    const matches = statements.filter((entry) => entry.kind === "key" && same(entry.path, target));
    if (matches.length > 1) throw new Error(`Global config contains duplicate ${tableName ? `[${tableName}].` : "top-level "}${key} entries.`);
    const ambiguous = statements.some((entry) => entry.path && (
      (entry.kind === "key" && prefix(entry.path, target) && !same(entry.path, target)) ||
      (entry.kind !== "key" && (prefix(target, entry.path) || (entry.kind === "arrayTable" && prefix(entry.path, target))))
    ));
    if (ambiguous || matches.some((entry) => !same(entry.table, table) || entry.key.length !== 1)) {
      throw new Error(`Global config contains an ambiguous ${tableName === "mcp_servers.playwright" ? "Playwright MCP" : tableName || key} definition.`);
    }
    const replacement = `${key} = ${JSON.stringify(value)}`;
    if (matches.length === 0) missing.push(replacement);
    else {
      const match = matches[0];
      replacements.push({ ...match, replacement: `${replacement}${match.comment ? ` ${match.comment}` : ""}` });
    }
  }
  for (const entry of replacements.sort((a, b) => b.start - a.start)) lines.splice(entry.start, entry.end - entry.start + 1, entry.replacement);
  if (missing.length === 0) return;
  const updated = tomlStatements(lines);
  const header = updated.find((entry) => entry.kind === "table" && same(entry.path, table));
  if (table.length > 0 && !header) {
    if (lines.length > 0 && lines.at(-1).trim() !== "") lines.push("");
    lines.push(`[${tableName}]`, ...missing);
    return;
  }
  const next = updated.find((entry) => ["table", "arrayTable"].includes(entry.kind) && entry.start > (header?.start ?? -1));
  let insertion = next?.start ?? lines.length;
  while (insertion > (header?.end ?? -1) + 1 && lines[insertion - 1].trim() === "") insertion -= 1;
  lines.splice(insertion, 0, ...missing);
}
