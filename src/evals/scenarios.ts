import type { EvalScenario } from "./types.js";
import {
  containsText,
  doesNotContain,
  intentIs,
  hasImages,
  noImages,
  isInSpanish,
  asksForTalla,
  mentionsAnticipo,
  mentionsPrice,
  doesNotRepeatCatalog,
  escalates,
  doesNotEscalate,
  confirmationGateHolds,
} from "./criteria.js";

export const scenarios: EvalScenario[] = [
  {
    name: "Frida — first contact greeting",
    description: "Customer sends informal greeting. Luis should greet warmly and ask what they're looking for.",
    turns: [
      {
        customerMessage: "Holisssss",
        criteria: [
          isInSpanish(),
          containsText("hola"),
          doesNotEscalate(),
          noImages(),
        ],
      },
    ],
  },
  {
    name: "Frida — browse catalog",
    description: "Customer asks to see available products. Luis should call browse_all_products and show images.",
    turns: [
      {
        customerMessage: "Quiero ver lo que tienes disponible",
        criteria: [
          isInSpanish(),
          intentIs("product_search"),
          hasImages(),
          doesNotEscalate(),
        ],
      },
    ],
  },
  {
    name: "Frida — two-step payment gate",
    description: "Customer asks for payment info. Luis must show summary and ask for confirmation — NOT send bank image yet.",
    turns: [
      {
        customerMessage: "Me puedes enviar a qué cuenta depositar",
        priorHistory: [
          { role: "user", content: "Quiero el jersey talla S" },
          {
            role: "assistant",
            content:
              '{"intent":"general","response":"¡Sí bonita! ⭐️Jersey Accolade Paradise Pink | Talla S | $3,390\\nTotal: $3,569\\nAnticipo (30%): $1,071 | Liquidas en 20 días 🙌🏼\\n¿Confirmas tu pedido para enviarte los datos de depósito? 🙏"}',
          },
        ],
        criteria: [
          isInSpanish(),
          doesNotEscalate(),
          confirmationGateHolds(),
          mentionsPrice(),
        ],
      },
    ],
  },
  {
    name: "Frida — hola after catalog shown",
    description: "Customer says Hola after already seeing the catalog. Luis must NOT show catalog again.",
    turns: [
      {
        customerMessage: "Hola",
        priorHistory: [
          { role: "user", content: "Madame los productos" },
          {
            role: "assistant",
            content:
              '{"intent":"product_search","response":"Aquí va lo que tengo ✨ [Productos enviados al cliente en este turn:\\n1. Jersey Accolade Paradise Pink — $3,390]"}',
          },
        ],
        criteria: [
          isInSpanish(),
          doesNotRepeatCatalog(),
          doesNotEscalate(),
        ],
      },
    ],
  },
  {
    name: "Gisell — color inquiry",
    description: "Customer asks what colors are available. Luis should search without color filter and show options.",
    turns: [
      {
        customerMessage: "Qué otro color tienes de la sudadera?",
        priorHistory: [
          { role: "user", content: "Quiero la sudadera crop" },
          {
            role: "assistant",
            content:
              '{"intent":"product_search","response":"Tengo la sudadera crop Alo en color rojo, mira 🙌🏼 [Productos enviados al cliente en este turn:\\n1. Sudadera crop Alo rojo — $3,390]"}',
          },
        ],
        criteria: [
          isInSpanish(),
          intentIs("product_search"),
          hasImages(),
          doesNotEscalate(),
        ],
      },
    ],
  },
  {
    name: "Gisell — urgency with deadline",
    description: "Customer mentions she needs it before Saturday. Luis should acknowledge urgency.",
    turns: [
      {
        customerMessage: "Me la puedes enviar antes del sábado? Me voy de viaje",
        priorHistory: [
          { role: "user", content: "Quiero la sudadera talla XS" },
          {
            role: "assistant",
            content:
              '{"intent":"general","response":"¡Sí bonita! Tengo disponible la talla XS 🙌🏼 ¿Confirmas tu pedido?"}',
          },
        ],
        criteria: [
          isInSpanish(),
          doesNotEscalate(),
          doesNotContain("no sé"),
          doesNotContain("no puedo"),
        ],
      },
    ],
  },
  {
    name: "Gisell — talla size advice",
    description: "Customer is unsure about size. Luis should give a recommendation.",
    turns: [
      {
        customerMessage: "Ay la falda no sé si XS o S, qué me recomiendas?",
        criteria: [
          isInSpanish(),
          doesNotEscalate(),
          {
            name: "gives size guidance",
            description: "Luis must give some size guidance or ask a clarifying question about size/fit",
            check: (response) => /talla|fit|ajustad[oa]|medida|recomend|quedar[áa]|pequeñ[oa]|grande|holgad[oa]|ceñid[oa]|amplio|amplia/i.test(response),
          },
        ],
      },
    ],
  },
  {
    name: "Gisell — buying for third party",
    description: "Customer is buying for her mom. Luis should continue the sale normally.",
    turns: [
      {
        customerMessage: "Me pregunta mi mamá si tienes este vestido para entrega inmediata",
        criteria: [
          isInSpanish(),
          doesNotEscalate(),
          asksForTalla(),
        ],
      },
    ],
  },
  {
    name: "Price negotiation — must escalate",
    description: "Customer proposes a custom price. Luis must escalate to owner.",
    turns: [
      {
        customerMessage: "Me lo dejas en $2,500 la sudadera?",
        criteria: [
          isInSpanish(),
          escalates(),
          containsText("equipo"),
          doesNotContain("acepto"),
          doesNotContain("claro"),
        ],
      },
    ],
  },
  {
    name: "Product not found — graceful response",
    description: "Customer asks for something not in inventory. Luis should respond gracefully without SAFE_FALLBACK.",
    turns: [
      {
        customerMessage: "Busco leggings negros talla S",
        searchProductsOverride: async () => [],
        criteria: [
          isInSpanish(),
          doesNotContain("permíteme un momento"),
          doesNotContain("ahorita te atiendo"),
        ],
      },
    ],
  },
];
