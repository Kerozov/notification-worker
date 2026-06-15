import * as XLSX from "xlsx";
import { normalizeRecipients } from "@/lib/validation/email-job";

const EMAIL_LIKE = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g;

function extractEmailsFromLine(line: string): string[] {
  const trimmed = line.trim();

  if (!trimmed) {
    return [];
  }

  const matches = trimmed.match(EMAIL_LIKE);
  return matches ?? [trimmed];
}

export function parseRecipientsFromText(text: string): string[] {
  const raw: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,;\t]/);

    for (const cell of cells) {
      raw.push(...extractEmailsFromLine(cell));
    }
  }

  return raw;
}

export function parseRecipientsFromFile(
  buffer: Buffer,
  filename: string,
): string[] {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });

    const raw: string[] = [];

    for (const row of rows) {
      if (!Array.isArray(row)) {
        continue;
      }

      for (const cell of row) {
        if (cell == null) {
          continue;
        }

        raw.push(...extractEmailsFromLine(String(cell)));
      }
    }

    return raw;
  }

  return parseRecipientsFromText(buffer.toString("utf-8"));
}

export function splitRecipients(raw: string[]) {
  return normalizeRecipients(raw);
}
