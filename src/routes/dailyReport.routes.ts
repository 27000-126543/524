import { Router } from 'express';
import { param, query } from 'express-validator';
import { generateDailyReport, getDailyReports, exportDailyReport } from '../controllers/dailyReport.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/generate',
  authenticate,
  requireRoles(UserRole.ADMIN, UserRole.LAB_DIRECTOR),
  [query('date').optional().isISO8601()],
  generateDailyReport
);

router.get(
  '/',
  authenticate,
  requireRoles(UserRole.ADMIN, UserRole.LAB_DIRECTOR),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getDailyReports
);

router.get(
  '/:date/export',
  authenticate,
  requireRoles(UserRole.ADMIN, UserRole.LAB_DIRECTOR),
  [
    param('date').isISO8601(),
    query('format').optional().isIn(['xlsx', 'csv']),
  ],
  exportDailyReport
);

export default router;
