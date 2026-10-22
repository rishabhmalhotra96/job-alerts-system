import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import readExcelFile from "read-excel-file/node";

const SOURCE_URL = "https://enterprise.gov.ie/en/publications/publication-files/employment-permits-issued-to-companies-2026.xlsx";
const SNAPSHOT_PATH = resolve("data/dete-permit-history.json");
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_ROWS = 20_000;
const EXPECTED_HEADINGS = [
  "Employer Name",
  "Permits Issued Jan",
  "Permits Issued Feb",
  "Permits Issued Mar",
  "Permits Issued Apr",
  "Permits Issued May",
  "Permits Issued Jun",
  "Permits Issued Jul",
  "Permits Issued Aug",
  "Permits Issued Grand Total",
];
const REVIEWED_ENTITIES = [
  ["Google", ["Google Cloud EMEA Limited", "Google Ireland Limited"]],
  ["Amazon", [
    "Amazon Data Services Ireland Limited",
    "Amazon Development Centre Ireland Limited",
    "Amazon EU Sarl, Irish Branch",
    "Amazon Ireland Support Services Limited",
    "Amazon Web Services EMEA SARL",
  ]],
  ["Mastercard", ["Mastercard Ireland Limited"]],
  ["Microsoft", [
    "Microsoft Ireland Operations Limited",
    "Microsoft Ireland Research Unlimited Company",
    "Microsoft RL Unlimited Company",
  ]],
  ["Meta", ["Meta Platforms Ireland Limited"]],
  ["Stripe", ["Stripe Payments Europe Limited", "Stripe Technology Company Limited"]],
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function previousMonth(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) {
    throw new Error("PUBLICATION_MONTH_INVALID");
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return date.toISOString().slice(0, 7);
}

function normalizeLegalEntity(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function sourceBytes(inputPath) {
  if (inputPath !== null) {
    if (extname(inputPath).toLowerCase() !== ".xlsx") {
      throw new Error("SOURCE_FILE_TYPE_INVALID");
    }
    return { bytes: await readFile(inputPath), publicationMonth: option("--publication-month") };
  }

  const source = new URL(SOURCE_URL);
  if (source.protocol !== "https:" || source.hostname !== "enterprise.gov.ie") {
    throw new Error("SOURCE_HOST_INVALID");
  }
  const response = await fetch(source, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`SOURCE_HTTP_${response.status}`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    throw new Error("SOURCE_CONTENT_TYPE_INVALID");
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_BYTES) {
    throw new Error("SOURCE_SIZE_INVALID");
  }
  const lastModified = response.headers.get("last-modified");
  const lastModifiedDate = new Date(lastModified ?? "");
  if (!Number.isFinite(lastModifiedDate.getTime())) {
    throw new Error("SOURCE_PUBLICATION_PERIOD_MISSING");
  }
  if (response.body === null) {
    throw new Error("SOURCE_BODY_MISSING");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_SOURCE_BYTES) {
      throw new Error("SOURCE_SIZE_INVALID");
    }
    chunks.push(Buffer.from(chunk));
  }
  return {
    bytes: Buffer.concat(chunks, size),
    publicationMonth: lastModifiedDate.toISOString().slice(0, 7),
  };
}

export async function buildDeteSnapshot(bytes, publicationMonth) {
  if (bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) {
    throw new Error("SOURCE_SIZE_INVALID");
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("SOURCE_FILE_TYPE_INVALID");
  }
  if (publicationMonth === null) {
    throw new Error("PUBLICATION_MONTH_REQUIRED");
  }

  const sheets = await readExcelFile(bytes);
  if (sheets.length !== 1 || sheets[0].sheet !== "Export") {
    throw new Error("WORKBOOK_SHEETS_INVALID");
  }
  const rows = sheets[0].data;
  if (rows.length < 2 || rows.length > MAX_ROWS
    || JSON.stringify(rows[0]) !== JSON.stringify(EXPECTED_HEADINGS)) {
    throw new Error("WORKBOOK_SCHEMA_INVALID");
  }

  const rowsByEntity = new Map();
  for (const row of rows.slice(1)) {
    if (row.length !== EXPECTED_HEADINGS.length || typeof row[0] !== "string") {
      throw new Error("WORKBOOK_ROW_INVALID");
    }
    const monthly = row.slice(1, 9).map((value) => value === null ? 0 : value);
    const total = row[9];
    if (monthly.some((value) => !Number.isInteger(value) || value < 0)
      || !Number.isInteger(total)
      || total < 0
      || monthly.reduce((sum, value) => sum + value, 0) !== total) {
      throw new Error("WORKBOOK_PERMIT_TOTAL_INVALID");
    }
    const name = normalizeLegalEntity(row[0]);
    const matches = rowsByEntity.get(name) ?? [];
    matches.push(total);
    rowsByEntity.set(name, matches);
  }

  const entities = REVIEWED_ENTITIES.map(([company, legalEntities]) => ({
    company,
    legalEntities: legalEntities.map((legalEntity) => {
      const matches = rowsByEntity.get(legalEntity) ?? [];
      if (matches.length !== 1 || matches[0] <= 0) {
        throw new Error(`REVIEWED_ENTITY_INVALID:${legalEntity}`);
      }
      return legalEntity;
    }),
  }));
  return {
    schemaVersion: 1,
    provider: "DETE",
    sourceUrl: SOURCE_URL,
    publicationMonth,
    evidenceThroughMonth: previousMonth(publicationMonth),
    sourceFileSha256: createHash("sha256").update(bytes).digest("hex"),
    entities,
  };
}

async function main() {
  const current = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
  const inputPath = option("--input");
  const source = await sourceBytes(inputPath);
  if (process.argv.includes("--write") && inputPath !== null && source.publicationMonth === null) {
    throw new Error("PUBLICATION_MONTH_REQUIRED");
  }
  const publicationMonth = source.publicationMonth ?? current.publicationMonth;
  const snapshot = await buildDeteSnapshot(source.bytes, publicationMonth);
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await writeFile(SNAPSHOT_PATH, serialized, "utf8");
    console.log(`Updated ${SNAPSHOT_PATH}`);
    return;
  }
  if (serialized !== `${JSON.stringify(current, null, 2)}\n`) {
    throw new Error("SNAPSHOT_OUT_OF_DATE");
  }
  console.log(`DETE snapshot verified: ${snapshot.entities.length} companies, ${snapshot.sourceFileSha256}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}