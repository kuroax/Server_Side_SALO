import Anthropic from '@anthropic-ai/sdk';
import { ProductModel } from '#/modules/products/product.model.js';
import { ANTHROPIC_API_KEY, WHATSAPP_ACCESS_TOKEN } from '#/config/env.js';
import { logger } from '#/config/logger.js';

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────

type ClothingAttributes = {
  categoryGroup:    string;
  subcategory:      string;
  gender:           string;
  colorDescription: string;
};

export type ImageSearchResult = {
  reply:         string;
  productImages: string[];
};

// ─── Step 1 — Download image from Meta API ────────────────────────────────────
// Meta image downloads require two steps:
//   1. GET /v20.0/{mediaId} → returns { url: string }
//   2. GET {url} with Authorization header → returns the actual image bytes

async function downloadMetaImage(
  mediaId: string,
): Promise<{ base64: string; mediaType: string }> {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!metaRes.ok) {
    throw new Error(`Meta media URL fetch failed — status ${metaRes.status}`);
  }

  const { url } = (await metaRes.json()) as { url: string };

  const imgRes = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
  });

  if (!imgRes.ok) {
    throw new Error(`Meta image download failed — status ${imgRes.status}`);
  }

  const contentType = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const buffer      = await imgRes.arrayBuffer();
  const base64      = Buffer.from(buffer).toString('base64');

  return { base64, mediaType: contentType };
}

// ─── Step 2 — Analyze clothing with Claude Vision ─────────────────────────────

async function analyzeClothingImage(
  base64:    string,
  mediaType: string,
): Promise<ClothingAttributes> {
  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type:   'image',
            source: {
              type:       'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data:       base64,
            },
          },
          {
            type: 'text',
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

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  return JSON.parse(raw) as ClothingAttributes;
}

// ─── Step 3 — Search MongoDB by extracted attributes ──────────────────────────

async function findMatchingProducts(attrs: ClothingAttributes) {
  const query: Record<string, unknown> = { status: 'active' };

  if (attrs.categoryGroup) {
    query['categoryGroup'] = { $regex: attrs.categoryGroup, $options: 'i' };
  }

  if (attrs.gender && attrs.gender !== 'unisex') {
    query['gender'] = attrs.gender;
  }

  const subcategoryTerms = attrs.subcategory
    .split(/\s+/)
    .filter((w) => w.length > 3);

  if (subcategoryTerms.length > 0) {
    query['$or'] = [
      { subcategory: { $regex: subcategoryTerms.join('|'), $options: 'i' } },
      { name:        { $regex: subcategoryTerms.join('|'), $options: 'i' } },
    ];
  }

  return ProductModel.find(query)
    .select('name price images description subcategory')
    .limit(3)
    .lean();
}

// ─── Public service ───────────────────────────────────────────────────────────

export async function searchProductsByImage(
  mediaId: string,
): Promise<ImageSearchResult> {
  try {
    logger.info({ mediaId }, 'Starting image-based product search');

    const { base64, mediaType } = await downloadMetaImage(mediaId);
    const attrs                 = await analyzeClothingImage(base64, mediaType);

    logger.info({ attrs }, 'Clothing attributes extracted from image');

    const products = await findMatchingProducts(attrs);

    if (products.length === 0) {
      logger.info({ attrs }, 'No matching products found for image');
      return {
        reply:         'Ahorita te confirmo eso bonita, dame un momento 🙏🏻',
        productImages: [],
      };
    }

    const lines         = products.map((p) => `⭐️ ${p.name} — $${p.price} MXN`).join('\n');
    const reply         = `Encontré estos productos similares bonita! 🙌🏼\n\n${lines}\n\n¿Alguno te llama la atención? 💫`;
    const productImages = products.flatMap((p) => p.images ?? []).slice(0, 3) as string[];

    logger.info(
      { productCount: products.length, imageCount: productImages.length },
      'Image search completed',
    );

    return { reply, productImages };
  } catch (err) {
    logger.error({ err }, 'Image search failed — returning safe fallback');
    return {
      reply:         'Ahorita te confirmo eso bonita, dame un momento 🙏🏻',
      productImages: [],
    };
  }
}