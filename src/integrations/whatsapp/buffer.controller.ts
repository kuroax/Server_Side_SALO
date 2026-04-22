import type { Request, Response } from 'express';
import { pushToBuffer, claimBuffer } from '#/integrations/whatsapp/buffer.service.js';
import { logger } from '#/config/logger.js';

export const bufferPushHandler = async (req: Request, res: Response): Promise<void> => {
  const {
    from,
    message,
    executionId,
    messageId,
    messageType,
    imageMediaId,
    imageCaption,
    contactName,
    timestamp,
  } = req.body;

  if (!from || !executionId) {
    res.status(400).json({ error: 'Missing required fields: from, executionId' });
    return;
  }

  try {
    const result = await pushToBuffer({
      from,
      message:      message      ?? '',
      executionId,
      messageId,
      messageType,
      imageMediaId: imageMediaId ?? null,
      imageCaption: imageCaption ?? '',
      contactName:  contactName  ?? 'Cliente',
      timestamp:    timestamp    ?? null,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err, from }, 'Buffer push failed');
    res.status(500).json({ error: 'Buffer push failed' });
  }
};

export const bufferClaimHandler = async (req: Request, res: Response): Promise<void> => {
  const { from, executionId } = req.body;

  if (!from || !executionId) {
    res.status(400).json({ error: 'Missing required fields: from, executionId' });
    return;
  }

  try {
    const result = await claimBuffer(from, executionId);
    res.json(result);
  } catch (err) {
    logger.error({ err, from }, 'Buffer claim failed');
    res.status(500).json({ error: 'Buffer claim failed' });
  }
};