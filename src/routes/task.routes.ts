import { Router } from 'express';
import { param, query } from 'express-validator';
import { assignTask, autoAssignTasks, startTask, completeTask, getTaskQueue, getDeviceLoad } from '../controllers/task.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/:taskId/assign',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [param('taskId').isUUID()],
  assignTask
);

router.post(
  '/auto-assign',
  authenticate,
  requireRoles(UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [query('departmentId').optional().isUUID()],
  autoAssignTasks
);

router.post(
  '/:taskId/start',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN),
  [param('taskId').isUUID()],
  startTask
);

router.post(
  '/:taskId/complete',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN),
  [param('taskId').isUUID()],
  completeTask
);

router.get(
  '/queue',
  authenticate,
  [
    query('departmentId').optional().isUUID(),
    query('deviceId').optional().isUUID(),
    query('status').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getTaskQueue
);

router.get(
  '/device-load',
  authenticate,
  [query('departmentId').optional().isUUID()],
  getDeviceLoad
);

export default router;
