import { Router } from 'express';
import { param, query } from 'express-validator';
import {
  triggerCriticalAlert, confirmCriticalNotification, runEscalationCheck,
  getCriticalNotifications, markNotificationRead, getCriticalTimeline,
  getReportCriticalLockInfo,
} from '../controllers/criticalValue.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/:reportId/trigger',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('reportId').isUUID()],
  triggerCriticalAlert
);

router.post(
  '/notification/:notificationId/confirm',
  authenticate,
  requireRoles(UserRole.CLINICIAN, UserRole.DEPARTMENT_HEAD, UserRole.MEDICAL_AFFAIRS, UserRole.ADMIN),
  [param('notificationId').isUUID()],
  confirmCriticalNotification
);

router.post(
  '/notification/:notificationId/read',
  authenticate,
  [param('notificationId').isUUID()],
  markNotificationRead
);

router.post(
  '/escalation-check',
  authenticate,
  requireRoles(UserRole.ADMIN, UserRole.LAB_DIRECTOR),
  runEscalationCheck
);

router.get(
  '/notifications',
  authenticate,
  [
    query('status').optional().isIn(['SENT', 'READ', 'CONFIRMED', 'ESCALATED']),
    query('level').optional().isIn(['LEVEL_1', 'LEVEL_2', 'LEVEL_3']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
    query('reportNo').optional().isString(),
    query('patientName').optional().isString(),
    query('confirmed').optional().isIn(['true', 'false', 'all']),
    query('escalated').optional().isIn(['true', 'false', 'all']),
  ],
  getCriticalNotifications
);

router.get(
  '/:reportId/timeline',
  authenticate,
  [param('reportId').isUUID()],
  getCriticalTimeline
);

router.get(
  '/:reportId/lock-info',
  authenticate,
  [param('reportId').isUUID()],
  getReportCriticalLockInfo
);

export default router;
