import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { getWorkOrders, getWorkOrderDetail, completeWorkOrder } from '../controllers/workOrder.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.get(
  '/',
  authenticate,
  [
    query('type').optional().isIn(['RECHECK', 'QC']),
    query('status').optional().isIn(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
    query('departmentId').optional().isUUID(),
    query('assignedToId').optional().isUUID(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getWorkOrders
);

router.get(
  '/:id',
  authenticate,
  [param('id').isUUID()],
  getWorkOrderDetail
);

router.post(
  '/:id/complete',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.LAB_DIRECTOR, UserRole.ADMIN),
  [
    param('id').isUUID(),
    body('completedNote').optional().isString(),
  ],
  completeWorkOrder
);

export default router;
