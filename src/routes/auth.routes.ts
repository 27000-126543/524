import { Router } from 'express';
import { body } from 'express-validator';
import { login, getProfile, getMyNotifications, markNotificationRead } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';

const router = Router();

router.post(
  '/login',
  [
    body('username').notEmpty().withMessage('用户名不能为空'),
    body('password').notEmpty().withMessage('密码不能为空'),
  ],
  login
);

router.get('/profile', authenticate, getProfile);

router.get('/notifications', authenticate, getMyNotifications);

router.put('/notifications/:id/read', authenticate, markNotificationRead);

export default router;
