import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { uploadResult, getSampleResults, getAbnormalResults } from '../controllers/result.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN),
  [
    body('sampleId').isUUID().withMessage('样本ID格式错误'),
    body('testId').isUUID().withMessage('检测项目ID格式错误'),
    body('resultValue').notEmpty().withMessage('结果值不能为空'),
    body('numericValue').optional().isNumeric(),
    body('unit').optional().isString(),
    body('taskId').optional().isUUID(),
  ],
  uploadResult
);

router.get(
  '/sample/:sampleId',
  authenticate,
  [param('sampleId').isUUID()],
  getSampleResults
);

router.get(
  '/abnormal',
  authenticate,
  [
    query('departmentId').optional().isUUID(),
    query('criticalOnly').optional().isBoolean(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getAbnormalResults
);

export default router;
