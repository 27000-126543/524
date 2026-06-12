import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { receiveSample, getSamples, getSampleDetail } from '../controllers/sample.controller';
import { authenticate, requireRoles } from '../middleware/auth';
import { UserRole } from '@prisma/client';

const router = Router();

router.post(
  '/',
  authenticate,
  requireRoles(UserRole.LAB_TECHNICIAN, UserRole.ADMIN),
  [
    body('patientId').isUUID().withMessage('患者ID格式错误'),
    body('sampleType').isIn(['BLOOD', 'URINE', 'STOOL', 'SPUTUM', 'CEREBROSPINAL', 'PLEURAL', 'ASCITIC', 'OTHER']).withMessage('样本类型无效'),
    body('testIds').isArray({ min: 1 }).withMessage('检测项目不能为空'),
    body('testIds.*').isUUID().withMessage('检测项目ID格式错误'),
    body('urgency').optional().isIn(['ROUTINE', 'URGENT', 'EMERGENCY', 'CRITICAL']),
    body('volume').optional().isString(),
    body('collectionTime').optional().isISO8601(),
    body('collectionSite').optional().isString(),
    body('collector').optional().isString(),
    body('requisitionId').optional().isUUID(),
  ],
  receiveSample
);

router.get(
  '/',
  authenticate,
  [
    query('status').optional().isIn(['RECEIVED', 'REJECTED', 'ASSIGNED', 'ANALYZING', 'ANALYZED', 'RECHECKING', 'REPORTING', 'REPORTED', 'ARCHIVED']),
    query('departmentId').optional().isUUID(),
    query('patientId').optional().isUUID(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
  ],
  getSamples
);

router.get(
  '/:id',
  authenticate,
  [param('id').isUUID()],
  getSampleDetail
);

export default router;
