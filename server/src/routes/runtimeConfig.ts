import { Router } from 'express';
import { config } from '../config';

const router = Router();

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    geetest: {
      enabled: config.geetest.enabled,
      ...(config.geetest.enabled ? { captchaId: config.geetest.captchaId } : {}),
    },
  });
});

export default router;
