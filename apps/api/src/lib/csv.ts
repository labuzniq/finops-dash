/**
 * Minimal RFC 4180 CSV parsing, shared by the seat importer and the billing
 * report importer. Quoted fields, escaped quotes, CRLF-tolerant. Extracted
 * from services/import.ts so both importers parse CSV identically.
 */

/** One parsed CSV row plus the 1-based physical line it started on. */
export interface CsvRow {
  cells: string[];
  line: number;
}

/** Strip a UTF-8 byte-order mark — exports from GitHub start with one. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into rows of raw string cells. The header row (if any) is
 * `rows[0]`; no trimming or case-folding happens here. Line numbers survive
 * quoted embedded newlines, so import errors can point at the real line.
 */
export function parseCsvRows(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++;
      row.push(field);
      rows.push({ cells: row, line: rowStartLine });
      field = '';
      row = [];
      rowStartLine = line;
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push({ cells: row, line: rowStartLine });
  }

  return rows;
}
