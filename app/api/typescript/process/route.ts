
import ExcelJS from "exceljs";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const AMOUNT_COLUMN = 9; // Column I

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;

type Summary = {
  totalRevenue: number;
  totalTransactions: number;
  invalidRows: number;
};

type ZipEntry = {
  name: string;
  central: Buffer;
  localOffset: number;
  compressedSize: number;
  compressionMethod: number;
  flags: number;
  localRecord: Buffer;
};

type ZipDirectory = {
  entries: ZipEntry[];
  comment: Buffer;
};

// ============================================================
// ZIP UTILITIES
// ============================================================

function crc32(data: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function findEocd(input: Buffer): number {
  const minimum = Math.max(0, input.length - 22 - 0xffff);

  for (let i = input.length - 22; i >= minimum; i--) {
    if (
      input.readUInt32LE(i) === EOCD &&
      i + 22 + input.readUInt16LE(i + 20) === input.length
    ) {
      return i;
    }
  }

  throw new Error("Invalid XLSX: ZIP directory not found.");
}

function parseZip(input: Buffer): ZipDirectory {
  const eocd = findEocd(input);

  const disk = input.readUInt16LE(eocd + 4);
  const centralDisk = input.readUInt16LE(eocd + 6);
  const diskEntries = input.readUInt16LE(eocd + 8);
  const totalEntries = input.readUInt16LE(eocd + 10);
  const centralSize = input.readUInt32LE(eocd + 12);
  const centralOffset = input.readUInt32LE(eocd + 16);
  const commentLength = input.readUInt16LE(eocd + 20);

  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error("Multi-disk ZIP files are not supported.");
  }

  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 XLSX files are not supported.");
  }

  if (centralOffset + centralSize > eocd) {
    throw new Error("Invalid XLSX central directory.");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (
      cursor + 46 > input.length ||
      input.readUInt32LE(cursor) !== CENTRAL
    ) {
      throw new Error("Invalid ZIP central directory entry.");
    }

    const flags = input.readUInt16LE(cursor + 8);
    const method = input.readUInt16LE(cursor + 10);
    const compressedSize = input.readUInt32LE(cursor + 20);
    const uncompressedSize = input.readUInt32LE(cursor + 24);
    const nameLength = input.readUInt16LE(cursor + 28);
    const extraLength = input.readUInt16LE(cursor + 30);
    const entryCommentLength = input.readUInt16LE(cursor + 32);
    const localOffset = input.readUInt32LE(cursor + 42);

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 entries are not supported.");
    }

    const centralLength =
      46 + nameLength + extraLength + entryCommentLength;

    if (cursor + centralLength > input.length) {
      throw new Error("Truncated ZIP central directory.");
    }

    const name = input
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    if (
      localOffset + 30 > input.length ||
      input.readUInt32LE(localOffset) !== LOCAL
    ) {
      throw new Error(`Invalid ZIP entry: ${name}`);
    }

    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);

    const dataOffset =
      localOffset + 30 + localNameLength + localExtraLength;

    const dataEnd = dataOffset + compressedSize;

    if (dataEnd > input.length) {
      throw new Error(`Truncated ZIP entry: ${name}`);
    }

    let recordEnd = dataEnd;

    if (flags & 0x0008) {
      if (
        recordEnd + 4 <= input.length &&
        input.readUInt32LE(recordEnd) === DESCRIPTOR
      ) {
        recordEnd += 16;
      } else {
        recordEnd += 12;
      }
    }

    if (recordEnd > input.length) {
      throw new Error(`Invalid ZIP descriptor: ${name}`);
    }

    entries.push({
      name,
      central: input.subarray(cursor, cursor + centralLength),
      localOffset,
      compressedSize,
      compressionMethod: method,
      flags,
      localRecord: input.subarray(localOffset, recordEnd),
    });

    cursor += centralLength;
  }

  return {
    entries,
    comment: input.subarray(
      eocd + 22,
      eocd + 22 + commentLength,
    ),
  };
}

function readZipEntry(input: Buffer, name: string): Buffer {
  const { entries } = parseZip(input);
  const entry = entries.find((item) => item.name === name);

  if (!entry) {
    throw new Error(`XLSX entry not found: ${name}`);
  }

  const localNameLength = input.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = input.readUInt16LE(entry.localOffset + 28);

  const dataOffset =
    entry.localOffset + 30 + localNameLength + localExtraLength;

  const compressed = input.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );

  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }

  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressed);
  }

  throw new Error(
    `Unsupported ZIP compression method: ${entry.compressionMethod}`,
  );
}

function makeLocalRecord(name: string, data: Buffer) {
  const nameBytes = Buffer.from(name, "utf8");
  const compressed = deflateRawSync(data, { level: 6 });
  const crc = crc32(data);

  const header = Buffer.alloc(30);

  header.writeUInt32LE(LOCAL, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);

  return {
    record: Buffer.concat([header, nameBytes, compressed]),
    crc,
    compressedSize: compressed.length,
  };
}

function makeCentralRecord(
  name: string,
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
  localOffset: number,
): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);

  header.writeUInt32LE(CENTRAL, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(localOffset, 42);

  return Buffer.concat([header, nameBytes]);
}

// Copy unchanged compressed ZIP entries without recompressing them.
function patchXlsxZip(
  input: Buffer,
  replacements: Map<string, Buffer | string>,
  additions: Map<string, Buffer | string>,
): Buffer {
  const { entries, comment } = parseZip(input);

  const existingNames = new Set(entries.map((entry) => entry.name));

  for (const name of additions.keys()) {
    if (existingNames.has(name)) {
      throw new Error(`ZIP entry already exists: ${name}`);
    }
  }

  for (const name of replacements.keys()) {
    if (!existingNames.has(name)) {
      throw new Error(`ZIP entry does not exist: ${name}`);
    }
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];

  let localOffset = 0;

  for (const entry of entries) {
    const replacement = replacements.get(entry.name);

    if (replacement !== undefined) {
      const data = Buffer.isBuffer(replacement)
        ? replacement
        : Buffer.from(replacement, "utf8");

      const local = makeLocalRecord(entry.name, data);

      localParts.push(local.record);

      centralParts.push(
        makeCentralRecord(
          entry.name,
          local.crc,
          local.compressedSize,
          data.length,
          localOffset,
        ),
      );

      localOffset += local.record.length;
      continue;
    }

    localParts.push(entry.localRecord);

    const central = Buffer.from(entry.central);
    central.writeUInt32LE(localOffset, 42);

    centralParts.push(central);

    localOffset += entry.localRecord.length;
  }

  for (const [name, value] of additions) {
    const data = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value, "utf8");

    const local = makeLocalRecord(name, data);

    localParts.push(local.record);

    centralParts.push(
      makeCentralRecord(
        name,
        local.crc,
        local.compressedSize,
        data.length,
        localOffset,
      ),
    );

    localOffset += local.record.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = localOffset;
  const totalEntries = entries.length + additions.size;

  if (
    totalEntries > 0xffff ||
    centralDirectory.length > 0xffffffff ||
    centralOffset > 0xffffffff
  ) {
    throw new Error("Resulting XLSX exceeds ZIP format limits.");
  }

  const eocd = Buffer.alloc(22);

  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(totalEntries, 8);
  eocd.writeUInt16LE(totalEntries, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);

  return Buffer.concat([
    ...localParts,
    centralDirectory,
    eocd,
    comment,
  ]);
}

// ============================================================
// EXCEL PROCESSING
// ============================================================

function getAmount(value: ExcelJS.CellValue): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().replace(/,/g, "");

    if (!normalized) return null;

    const amount = Number(normalized);

    return Number.isFinite(amount) ? amount : null;
  }

  if (typeof value === "object" && "result" in value) {
    return getAmount(value.result as ExcelJS.CellValue);
  }

  return null;
}

function processWorkbook(workbook: ExcelJS.Workbook): Summary {
  let totalRevenue = 0;
  let totalTransactions = 0;
  let invalidRows = 0;

  for (const worksheet of workbook.worksheets) {
    if (worksheet.name.toLowerCase() === "summary") {
      throw new Error(
        "The uploaded workbook already contains a Summary worksheet.",
      );
    }

    let headerSkipped = false;

    worksheet.eachRow(
      { includeEmpty: false },
      (row) => {
        if (!headerSkipped) {
          headerSkipped = true;
          return;
        }

        const amount = getAmount(
          row.getCell(AMOUNT_COLUMN).value,
        );

        if (amount === null) {
          invalidRows++;
          return;
        }

        totalRevenue += amount;
        totalTransactions++;
      },
    );
  }

  return {
    totalRevenue,
    totalTransactions,
    invalidRows,
  };
}

// ============================================================
// SUMMARY WORKSHEET XML
// ============================================================

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function summaryWorksheetXml(summary: Summary): string {
  const rows = [
    ["Metric", "Value"],
    ["Total Revenue", summary.totalRevenue.toFixed(2)],
    ["Total Transactions", String(summary.totalTransactions)],
    ["Invalid Rows", String(summary.invalidRows)],
  ];

  const rowXml = rows
    .map((row, rowIndex) => {
      const rowNumber = rowIndex + 1;

      const cells = row
        .map((value, columnIndex) => {
          const cellRef = `${columnIndex === 0 ? "A" : "B"}${rowNumber}`;

          if (rowIndex === 0 || columnIndex === 0) {
            return (
              `<c r="${cellRef}" t="inlineStr">` +
              `<is><t>${escapeXml(value)}</t></is></c>`
            );
          }

          return `<c r="${cellRef}"><v>${escapeXml(value)}</v></c>`;
        })
        .join("");

      return `<row r="${rowNumber}">${cells}</row>`;
    })
    .join("");

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<dimension ref="A1:B4"/>' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<sheetData>${rowXml}</sheetData>` +
    '</worksheet>'
  );
}

// ============================================================
// ADD SUMMARY SHEET TO XLSX PACKAGE
// ============================================================

function getNextSheetFile(entries: string[]): string {
  let maxNumber = 0;

  for (const name of entries) {
    const match = name.match(
      /^xl\/worksheets\/sheet(\d+)\.xml$/,
    );

    if (match) {
      maxNumber = Math.max(maxNumber, Number(match[1]));
    }
  }

  return `xl/worksheets/sheet${maxNumber + 1}.xml`;
}

function getNextSheetId(workbookXml: string): number {
  const ids = [
    ...workbookXml.matchAll(/\bsheetId="(\d+)"/g),
  ].map((match) => Number(match[1]));

  return Math.max(0, ...ids) + 1;
}

function getNextRelationshipId(relsXml: string): string {
  const ids = [
    ...relsXml.matchAll(/\bId="rId(\d+)"/g),
  ].map((match) => Number(match[1]));

  return `rId${Math.max(0, ...ids) + 1}`;
}

function addSummarySheet(
  input: Buffer,
  summary: Summary,
): Buffer {
  const { entries } = parseZip(input);
  const names = entries.map((entry) => entry.name);

  const workbookXml = readZipEntry(
    input,
    "xl/workbook.xml",
  ).toString("utf8");

  const relsXml = readZipEntry(
    input,
    "xl/_rels/workbook.xml.rels",
  ).toString("utf8");

  const contentTypesXml = readZipEntry(
    input,
    "[Content_Types].xml",
  ).toString("utf8");

  if (/<sheet\b[^>]*\bname="Summary"/i.test(workbookXml)) {
    throw new Error("A Summary worksheet already exists.");
  }

  const sheetPath = getNextSheetFile(names);
  const sheetFileName = sheetPath.split("/").pop()!;

  const sheetId = getNextSheetId(workbookXml);
  const relationshipId = getNextRelationshipId(relsXml);

  const newSheet =
    `<sheet name="Summary" sheetId="${sheetId}" ` +
    `r:id="${relationshipId}"/>`;

  const updatedWorkbookXml = workbookXml.replace(
    "</sheets>",
    `${newSheet}</sheets>`,
  );

  if (updatedWorkbookXml === workbookXml) {
    throw new Error("Could not update workbook sheets.");
  }

  const newRelationship =
    `<Relationship Id="${relationshipId}" ` +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
    `Target="worksheets/${sheetFileName}"/>`;

  const updatedRelationshipsXml = relsXml.replace(
    "</Relationships>",
    `${newRelationship}</Relationships>`,
  );

  if (updatedRelationshipsXml === relsXml) {
    throw new Error("Could not update workbook relationships.");
  }

  const newContentType =
    `<Override PartName="/${sheetPath}" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';

  const updatedContentTypesXml = contentTypesXml.replace(
    "</Types>",
    `${newContentType}</Types>`,
  );

  if (updatedContentTypesXml === contentTypesXml) {
    throw new Error("Could not update XLSX content types.");
  }

  return patchXlsxZip(
    input,
    new Map([
      ["xl/workbook.xml", updatedWorkbookXml],
      ["xl/_rels/workbook.xml.rels", updatedRelationshipsXml],
      ["[Content_Types].xml", updatedContentTypesXml],
    ]),
    new Map([
      [sheetPath, summaryWorksheetXml(summary)],
    ]),
  );
}

// ============================================================
// NEXT.JS POST ROUTE
// ============================================================

export async function POST(request: Request) {
  const started = performance.now();

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return Response.json(
        { error: "No file uploaded. Use form field 'file'." },
        { status: 400 },
      );
    }

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return Response.json(
        { error: "Only .xlsx files are supported." },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: "File exceeds the 50 MB limit." },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const workbook = new ExcelJS.Workbook();

    const loadStarted = performance.now();
    await workbook.xlsx.load(
      buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const loadMs = performance.now() - loadStarted;

    const processStarted = performance.now();
    const summary = processWorkbook(workbook);
    const processMs = performance.now() - processStarted;

    const packageStarted = performance.now();
    const outputBuffer = addSummarySheet(buffer, summary);
    const packageMs = performance.now() - packageStarted;

    const serverTotalMs = performance.now() - started;

    console.log("TYPESCRIPT BENCHMARK", {
      loadMs: Number(loadMs.toFixed(2)),
      processMs: Number(processMs.toFixed(2)),
      packageMs: Number(packageMs.toFixed(2)),
      serverTotalMs: Number(serverTotalMs.toFixed(2)),
      inputBytes: buffer.length,
      outputBytes: outputBuffer.length,
      totalRevenue: summary.totalRevenue,
      totalTransactions: summary.totalTransactions,
      invalidRows: summary.invalidRows,
    });

    return new Response(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",

        "Content-Disposition":
          'attachment; filename="processed.xlsx"',

        "Content-Length": String(outputBuffer.length),

        "X-Total-Revenue": summary.totalRevenue.toFixed(2),

        "X-Total-Transactions": String(
          summary.totalTransactions,
        ),

        "X-Invalid-Rows": String(summary.invalidRows),
      },
    });
  } catch (error) {
    console.error("Excel processing error:", error);

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to process workbook.",
      },
      { status: 500 },
    );
  }
}
