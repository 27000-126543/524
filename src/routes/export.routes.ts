import { Router } from 'express';
import { query } from 'express-validator';
import { exportTestList, exportFeeDetails } from '../controllers/export.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.get(
  '/test-list',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN, UserRole.CLINICIAN),
  [
    query('patientId').optional().isUUID(),
    query('departmentId').optional().isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('format').optional().isIn(['xlsx', 'csv', 'json']),
  ],
  exportTestList
);

router.get(
  '/fee-details',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN, UserRole.CLINICIAN),
  [
    query('patientId').optional().isUUID(),
    query('departmentId').optional().isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('format').optional().isIn(['xlsx', 'csv', 'json']),
  ],
  exportFeeDetails
);

export default router;
