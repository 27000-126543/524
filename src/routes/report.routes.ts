import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { generateReport, reviewReport, fixDraftReport, getReport, getReports } from '../controllers/report.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/generate/:sampleId',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('sampleId').isUUID()],
  generateReport
);

router.post(
  '/:reportId/review',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [
    param('reportId').isUUID(),
    body('action').isIn(['APPROVE', 'REJECT']).withMessage('操作类型无效'),
    body('comment').optional().isString(),
  ],
  reviewReport
);

router.post(
  '/:reportId/fix',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('reportId').isUUID()],
  fixDraftReport
);

router.get(
  '/',
  authenticate,
  [
    query('status').optional().isIn(['DRAFT', 'PENDING_REVIEW', 'LOCKED', 'APPROVED', 'DISTRIBUTED', 'ARCHIVED']),
    query('departmentId').optional().isUUID(),
    query('patientId').optional().isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('hasCritical').optional().isBoolean(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getReports
);

router.get(
  '/:reportId',
  authenticate,
  [param('reportId').isUUID()],
  getReport
);

export default router;
