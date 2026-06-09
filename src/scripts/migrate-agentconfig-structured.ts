/**
 * One-time migration — split the legacy agentConfig.salesInstructions blob into
 * the new structured fields (phrases, discoveryCategories, upsellRules,
 * sizeGuide, customInstructions).
 *
 * For each boutique that HAS salesInstructions and does NOT yet have any
 * structured field, the blob is parsed by its section headers:
 *
 *   "ESTILO Y FRASES:"            → phrases.{affirmations,emojiSet,closings,
 *                                     paymentAck,orderConfirm,negativeSticker}
 *   "CATEGORÍAS DE PRODUCTOS:"    → discoveryCategories ([CATEGORÍAS_DEL_CATÁLOGO])
 *   "UPSELL Y SET COMPLETION:" /
 *   "UPSELL Y BUNDLE:"            → upsellRules
 *   "RECOMENDACIÓN DE TALLA:" /
 *   "RECOMENDACIÓN DE TALLA / TAMAÑO:" → sizeGuide
 *   "TEXTURA / MATERIAL:" /
 *   "MATERIAL / PRODUCTO:"        → appended to customInstructions
 *
 * If a section is missing or a value can't be extracted cleanly, the raw section
 * text is parked in customInstructions rather than guessing, and a warning logs.
 *
 * salesInstructions is NOT deleted — it stays as a fallback during the
 * transition window (buildAgentSection prefers structured fields when present).
 *
 * Idempotent: a boutique that already has structured fields is skipped.
 *
 * Usage:
 *   npm run migrate:agentconfig-structured
 *   # or: npx tsx src/scripts/migrate-agentconfig-structured.ts
 *
 * Required env vars (validated by src/config/env.ts): MONGODB_URI
 */

import mongoose from "mongoose";
import { MONGODB_URI } from "#/config/env.js";
import { BoutiqueModel } from "#/modules/boutiques/boutique.model.js";
import { logger } from "#/config/logger.js";

// ─── Section headers ────────────────────────────────────────────────────────────

const STYLE_HEADER = "ESTILO Y FRASES:";
const CATEGORIES_HEADER = "CATEGORÍAS DE PRODUCTOS:";
const UPSELL_HEADERS = ["UPSELL Y SET COMPLETION:", "UPSELL Y BUNDLE:"];
const SIZE_HEADERS = [
  "RECOMENDACIÓN DE TALLA / TAMAÑO:",
  "RECOMENDACIÓN DE TALLA:",
];
const TEXTURE_HEADERS = ["TEXTURA / MATERIAL:", "MATERIAL / PRODUCTO:"];

const ALL_HEADERS = [
  STYLE_HEADER,
  CATEGORIES_HEADER,
  ...UPSELL_HEADERS,
  ...SIZE_HEADERS,
  ...TEXTURE_HEADERS,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Splits the blob into a header→body map. A section body runs from just after
// its header up to the start of the next header that appears in the text.
function extractSections(blob: string): Map<string, string> {
  const found = ALL_HEADERS.map((header) => ({
    header,
    index: blob.indexOf(header),
  }))
    .filter((h) => h.index !== -1)
    .sort((a, b) => a.index - b.index);

  const sections = new Map<string, string>();
  for (let i = 0; i < found.length; i++) {
    const start = found[i].index + found[i].header.length;
    const end = i + 1 < found.length ? found[i + 1].index : blob.length;
    sections.set(found[i].header, blob.slice(start, end).trim());
  }
  return sections;
}

function firstSection(
  sections: Map<string, string>,
  headers: string[],
): string | undefined {
  for (const h of headers) {
    const v = sections.get(h);
    if (v) return v;
  }
  return undefined;
}

// Removes a single pair of wrapping double quotes, if present.
function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matchLine(body: string, re: RegExp): string | undefined {
  const m = body.match(re);
  return m ? m[1].trim() : undefined;
}

type ExtractedPhrases = {
  affirmations?: string;
  emojiSet?: string;
  closings?: string;
  paymentAck?: string;
  orderConfirm?: string;
  negativeSticker?: string;
};

function parsePhrases(styleBody: string): ExtractedPhrases {
  return {
    affirmations: matchLine(styleBody, /-\s*AFIRMACIONES:\s*(.+)/),
    emojiSet: matchLine(styleBody, /-\s*EMOJIS[^:]*:\s*(.+)/),
    closings: matchLine(styleBody, /-\s*FRASES DE CIERRE:\s*(.+)/),
    paymentAck: (() => {
      const v = matchLine(styleBody, /-\s*\[FRASE_AGRADECIMIENTO_PAGO\]\s*=\s*(.+)/);
      return v ? stripWrappingQuotes(v) : undefined;
    })(),
    orderConfirm: (() => {
      const v = matchLine(styleBody, /-\s*\[FRASE_CONFIRMACION_PEDIDO\]\s*=\s*(.+)/);
      return v ? stripWrappingQuotes(v) : undefined;
    })(),
    negativeSticker: (() => {
      const v = matchLine(styleBody, /-\s*STICKER NEGATIVO:\s*(.+)/);
      return v ? stripWrappingQuotes(v) : undefined;
    })(),
  };
}

// ─── Migration ──────────────────────────────────────────────────────────────────

const STRUCTURED_KEYS = [
  "phrases",
  "discoveryCategories",
  "upsellRules",
  "sizeGuide",
] as const;

async function main(): Promise<void> {
  await mongoose.connect(MONGODB_URI);
  logger.info("Connected to MongoDB — migrating agentConfig to structured fields");

  const boutiques = await BoutiqueModel.find().lean();

  let migrated = 0;
  let skipped = 0;

  for (const boutique of boutiques) {
    const slug = boutique.slug ?? "(no slug)";
    const ac = boutique.agentConfig as Record<string, unknown> | undefined;
    const blob =
      ac && typeof ac.salesInstructions === "string"
        ? ac.salesInstructions
        : undefined;

    if (!blob) {
      skipped++;
      logger.info({ boutiqueId: boutique._id.toString(), slug }, "skip — no salesInstructions blob");
      continue;
    }

    const alreadyStructured = STRUCTURED_KEYS.some(
      (k) => ac && ac[k] !== undefined && ac[k] !== null,
    );
    if (alreadyStructured) {
      skipped++;
      logger.info(
        { boutiqueId: boutique._id.toString(), slug },
        "skip — already has structured fields",
      );
      continue;
    }

    const sections = extractSections(blob);
    const set: Record<string, unknown> = {};
    const fieldsExtracted: string[] = [];
    const customInstructionsParts: string[] = [];

    // ── ESTILO Y FRASES → phrases ───────────────────────────────────────────────
    const styleBody = sections.get(STYLE_HEADER);
    if (styleBody) {
      const phrases = parsePhrases(styleBody);
      const definedPhrases = Object.fromEntries(
        Object.entries(phrases).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(definedPhrases).length > 0) {
        set["agentConfig.phrases"] = definedPhrases;
        fieldsExtracted.push(
          ...Object.keys(definedPhrases).map((k) => `phrases.${k}`),
        );
      } else {
        logger.warn(
          { boutiqueId: boutique._id.toString(), slug },
          "ESTILO Y FRASES present but no phrase fields parsed — parking raw text in customInstructions",
        );
        customInstructionsParts.push(`ESTILO Y FRASES:\n${styleBody}`);
      }
    }

    // ── CATEGORÍAS DE PRODUCTOS → discoveryCategories ───────────────────────────
    const categoriesBody = sections.get(CATEGORIES_HEADER);
    if (categoriesBody) {
      const cat = matchLine(
        categoriesBody,
        /-\s*\[CATEGORÍAS_DEL_CATÁLOGO\]\s*=\s*(.+)/,
      );
      if (cat) {
        set["agentConfig.discoveryCategories"] = stripWrappingQuotes(cat);
        fieldsExtracted.push("discoveryCategories");
      } else {
        logger.warn(
          { boutiqueId: boutique._id.toString(), slug },
          "CATEGORÍAS section present but [CATEGORÍAS_DEL_CATÁLOGO] not parsed — parking raw text in customInstructions",
        );
        customInstructionsParts.push(`CATEGORÍAS DE PRODUCTOS:\n${categoriesBody}`);
      }
    }

    // ── UPSELL → upsellRules ────────────────────────────────────────────────────
    const upsellBody = firstSection(sections, UPSELL_HEADERS);
    if (upsellBody) {
      set["agentConfig.upsellRules"] = upsellBody;
      fieldsExtracted.push("upsellRules");
    }

    // ── RECOMENDACIÓN DE TALLA → sizeGuide ──────────────────────────────────────
    const sizeBody = firstSection(sections, SIZE_HEADERS);
    if (sizeBody) {
      set["agentConfig.sizeGuide"] = sizeBody;
      fieldsExtracted.push("sizeGuide");
    }

    // ── TEXTURA / MATERIAL → customInstructions ─────────────────────────────────
    const textureBody = firstSection(sections, TEXTURE_HEADERS);
    if (textureBody) {
      customInstructionsParts.push(`TEXTURA / MATERIAL:\n${textureBody}`);
    }

    if (customInstructionsParts.length > 0) {
      const existing =
        ac && typeof ac.customInstructions === "string"
          ? ac.customInstructions
          : undefined;
      set["agentConfig.customInstructions"] = [
        existing,
        ...customInstructionsParts,
      ]
        .filter(Boolean)
        .join("\n\n");
      fieldsExtracted.push("customInstructions");
    }

    if (Object.keys(set).length === 0) {
      skipped++;
      logger.warn(
        { boutiqueId: boutique._id.toString(), slug },
        "skip — salesInstructions present but no recognizable sections extracted",
      );
      continue;
    }

    set.agentConfigVersion = 1;
    set.agentConfigUpdatedAt = new Date();

    await BoutiqueModel.updateOne({ _id: boutique._id }, { $set: set });
    migrated++;

    const remainingInBlob = ALL_HEADERS.filter((h) => !sections.has(h));
    logger.info(
      {
        boutiqueId: boutique._id.toString(),
        slug,
        fieldsExtracted,
        sectionsFound: [...sections.keys()],
        salesInstructionsKept: true,
      },
      "agentConfig structured migration succeeded",
    );
    void remainingInBlob;
  }

  logger.info({ migrated, skipped, total: boutiques.length }, "migration complete");
}

main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, "agentConfig structured migration failed");
    try {
      await mongoose.disconnect();
    } catch {
      // ignore disconnect errors during failure path
    }
    process.exit(1);
  });
