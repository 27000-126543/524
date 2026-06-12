import { Router } from 'express';
import { param, query } from 'express-validator';
import { distributeReport, archiveReport, autoArchiveReports, getPatientReports } from '../controllers/distribution.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/:reportId/distribute',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('reportId').isUUID()],
  distributeReport
);

router.post(
  '/:reportId/archive',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('reportId').isUUID()],
  archiveReport
);

router.post(
  '/auto-archive',
  authenticate,
  requireRoles(UserRole.ADMIN),
  autoArchiveReports
);

router.get(
  '/patient/:patientId',
  authenticate,
  [
    param('patientId').isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getPatientReports
);

export default router;
