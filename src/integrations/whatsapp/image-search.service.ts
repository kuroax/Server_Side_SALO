import Anthropic from "@anthropic-ai/sdk";
import { Types } from "mongoose";
import { ProductModel } from "#/modules/products/product.model.js";
import { UsageLogModel } from "#/modules/usageLogs/usageLog.model.js";
import { ANTHROPIC_API_KEY } from "#/config/env.js";
import { logger } from "#/config/logger.js";

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Escape regex metacharacters so Claude-vision-derived strings are safe in
// $regex queries (same pattern as webhook.product-search.ts) — an unescaped
// special char would throw a MongoError and kill the visual search.
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ─── Types ────────────────────────────────────────────────────────────────────

type ClothingAttributes = {
  categoryGroup: string;
  subcategory: string;
  gender: string;
  colorDescription: string;
};

export type ImageSearchResult = {
  reply: string;
  productImages: Array<{ url: string; caption?: string }>;
};

// ─── Step 1 — Download image from Meta API ────────────────────────────────────
// Meta image downloads require two steps:
//   1. GET /v20.0/{mediaId} → returns { url: string }
//   2. GET {url} with Authorization header → returns the actual image bytes

async function downloadMetaImage(
  mediaId: string,
  accessToken: string,
): Promise<{ base64: string; mediaType: string }> {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaRes.ok) {
    throw new Error(`Meta media URL fetch failed — status ${metaRes.status}`);
  }

  const { url } = (await metaRes.json()) as { url: string };

  const imgRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!imgRes.ok) {
    throw new Error(`Meta image download failed — status ${imgRes.status}`);
  }

  const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";
  const buffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return { base64, mediaType: contentType };
}

// ─── Step 2 — Analyze clothing with Claude Vision ─────────────────────────────

async function analyzeClothingImage(
  base64: string,
  mediaType: string,
  boutiqueId: string,
): Promise<ClothingAttributes> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: base64,
            },
          },
          {
            type: "text",
            text: `You are analyzing a clothing item for a boutique inventory search.
Respond ONLY with a JSON object — no markdown, no explanation, no text before or after:
{
  "categoryGroup": one of "Tops" | "Bottoms" | "Dresses" | "Outerwear" | "Activewear" | "Accessories",
  "subcategory": "specific type, e.g. Short Sleeve Tops, Leggings, Cropped Tops, Joggers",
  "gender": one of "women" | "men" | "unisex",
  "colorDescription": "main color or colors visible in the item"
}`,
          },
        ],
      },
    ],
  });

  // Non-blocking per-boutique usage log for the vision call. Without this, every
  // visual search consumed Claude tokens that were never attributed to the
  // boutique. Never awaited and never throws — a failed write must not break the
  // search flow.
  UsageLogModel.create({
    boutiqueId: new Types.ObjectId(boutiqueId),
    model: "claude-sonnet-4-6",
    intent: "image_search",
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    toolIterations: 1,
    createdAt: new Date(),
  }).catch((err) =>
    logger.warn({ err }, "UsageLog image-search write failed"),
  );

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return JSON.parse(raw) as ClothingAttributes;
}

// ─── Step 3 — Search MongoDB by extracted attributes ──────────────────────────

async function findMatchingProducts(
  attrs: ClothingAttributes,
  boutiqueId: string,
) {
  // Tenant scope FIRST — the boutiqueId filter prevents visual search from
  // returning products that belong to another boutique.
  const query: Record<string, unknown> = {
    boutiqueId: new Types.ObjectId(boutiqueId),
    status: "active",
  };

  if (attrs.categoryGroup) {
    query["categoryGroup"] = {
      $regex: escapeRegex(attrs.categoryGroup),
      $options: "i",
    };
  }

  if (attrs.gender && attrs.gender !== "unisex") {
    query["gender"] = attrs.gender;
  }

  const subcategoryTerms = attrs.subcategory
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (subcategoryTerms.length > 0) {
    const subcategoryPattern = subcategoryTerms.map(escapeRegex).join("|");
    query["$or"] = [
      { subcategory: { $regex: subcategoryPattern, $options: "i" } },
      { name: { $regex: subcategoryPattern, $options: "i" } },
    ];
  }

  return ProductModel.find(query)
    .select("name price images description subcategory")
    .limit(3)
    .lean();
}

// ─── Public service ───────────────────────────────────────────────────────────

export async function searchProductsByImage(
  mediaId: string,
  accessToken: string,
  boutiqueId: string,
): Promise<ImageSearchResult> {
  try {
    logger.info({ mediaId }, "Starting image-based product search");

    const { base64, mediaType } = await downloadMetaImage(mediaId, accessToken);
    const attrs = await analyzeClothingImage(base64, mediaType, boutiqueId);

    logger.info({ attrs }, "Clothing attributes extracted from image");

    const products = await findMatchingProducts(attrs, boutiqueId);

    if (products.length === 0) {
      logger.info({ attrs }, "No matching products found for image");
      return {
        reply:
          "Ahorita te confirmo eso bonita, dame un momento \uD83D\uDE4F\uD83C\uDFFB",
        productImages: [],
      };
    }

    const lines = products
      .map((p) => `\u2B50\uFE0F ${p.name} \u2014 $${p.price} MXN`)
      .join("\n");
    const reply = `Encontr\u00E9 estos productos similares bonita! \uD83D\uDE4C\uD83C\uDFC0\n\n${lines}\n\n\u00BFAlguno te llama la atenci\u00F3n? \uD83D\uDCAB`;

    // Build image objects for each product.
    // Filter: skip any stored slot that is empty, null, or not a string —
    // defensive against old data or direct DB writes that bypass Zod validation.
    // Caption: only the first image per product carries the product name and price;
    // subsequent angles are sent without caption to avoid repetitive text.
    // Slice: visual similarity search is capped at 5 total to avoid overwhelming
    // the customer. Matches the 5-image-per-product limit in the product UI.
    const productImages: Array<{ url: string; caption?: string }> = products
      .flatMap((p) => {
        const caption = `\u2B50\uFE0F ${p.name} \u2014 $${p.price} MXN`;
        return ((p.images ?? []) as string[])
          .filter(
            (url): url is string =>
              typeof url === "string" && url.trim().length > 0,
          )
          .map((url, idx) => ({
            url,
            caption: idx === 0 ? caption : undefined,
          }));
      })
      .slice(0, 5);

    logger.info(
      { productCount: products.length, imageCount: productImages.length },
      "Image search completed",
    );

    return { reply, productImages };
  } catch (err) {
    logger.error({ err }, "Image search failed — returning safe fallback");
    return {
      reply:
        "Ahorita te confirmo eso bonita, dame un momento \uD83D\uDE4F\uD83C\uDFFB",
      productImages: [],
    };
  }
}
