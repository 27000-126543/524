import prisma from '../lib/prisma';
import { ResultFlag, WorkOrderType, WorkOrderStatus, SampleStatus, Sample } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';
import logger from '../lib/logger';
import { wsManager } from '../lib/ws';

export interface UploadResultInput {
  sampleId: string;
  taskId?: string;
  testId: string;
  resultValue: string;
  numericValue?: number;
  unit?: string;
  testedBy: string;
}

class ResultUploadService {
  private parseReferenceRange(rangeStr?: string): {
    isQualitative: boolean;
    referenceIsNegative?: boolean;
    referenceIsPositive?: boolean;
    expectedPositiveValues?: string[];
    min?: number;
    max?: number;
  } {
    if (!rangeStr) {
      return { isQualitative: false };
    }

    if (/^阴性$/i.test(rangeStr.trim()) || /^-$/.test(rangeStr.trim())) {
      return { isQualitative: true, referenceIsNegative: true };
    }

    if (/^阳性$/i.test(rangeStr.trim()) || /^\+$/.test(rangeStr.trim())) {
      return { isQualitative: true, referenceIsPositive: true };
    }

    const positiveMatch = rangeStr.match(/^阳性:\s*(.+)$/i);
    if (positiveMatch) {
      return {
        isQualitative: true,
        referenceIsPositive: true,
        expectedPositiveValues: positiveMatch[1].split(/[,，、;；]/).map(s => s.trim()),
      };
    }

    if (rangeStr.includes('阴性') && !rangeStr.includes('阳性')) {
      return { isQualitative: true, referenceIsNegative: true };
    }

    if (rangeStr.includes('阳性') && !rangeStr.includes('阴性')) {
      return { isQualitative: true, referenceIsPositive: true };
    }

    const numericMatch = rangeStr.match(/([\d.]+)\s*[-~]\s*([\d.]+)/);
    if (numericMatch) {
      return {
        isQualitative: false,
        min: parseFloat(numericMatch[1]),
        max: parseFloat(numericMatch[2]),
      };
    }

    const minMatch = rangeStr.match(/[≥>]\s*([\d.]+)/);
    if (minMatch) {
      return { isQualitative: false, min: parseFloat(minMatch[1]) };
    }

    const maxMatch = rangeStr.match(/[≤<]\s*([\d.]+)/);
    if (maxMatch) {
      return { isQualitative: false, max: parseFloat(maxMatch[1]) };
    }

    return { isQualitative: false };
  }

  private evaluateResultFlag(
    value: string,
    numericValue: number | undefined,
    test: any
  ): { flag: ResultFlag; isAbnormal: boolean; isCritical: boolean } {
    const reference = this.parseReferenceRange(test.referenceRange);

    if (reference.isQualitative) {
      const isResultPositive =
        /阳性|\+\+|\+|positive/i.test(value) ||
        (reference.expectedPositiveValues?.some(p =>
          value.toLowerCase().includes(p.toLowerCase())
        ) ?? false);

      const isResultNegative =
        /阴性|-|negative/i.test(value);

      if (reference.referenceIsNegative) {
        const isAbnormal = !isResultNegative || isResultPositive;
        return {
          flag: isAbnormal ? ResultFlag.ABNORMAL_HIGH : ResultFlag.NORMAL,
          isAbnormal,
          isCritical: false,
        };
      }

      if (reference.referenceIsPositive) {
        const isAbnormal = !isResultPositive;
        return {
          flag: isAbnormal ? ResultFlag.ABNORMAL_LOW : ResultFlag.NORMAL,
          isAbnormal,
          isCritical: false,
        };
      }

      return {
        flag: ResultFlag.NORMAL,
        isAbnormal: false,
        isCritical: false,
      };
    }

    if (numericValue === undefined || isNaN(numericValue)) {
      return { flag: ResultFlag.INCONCLUSIVE, isAbnormal: false, isCritical: false };
    }

    let flag: ResultFlag = ResultFlag.NORMAL;
    let isAbnormal = false;
    let isCritical = false;

    const critLow = test.criticalLow ? parseFloat(test.criticalLow) : undefined;
    const critHigh = test.criticalHigh ? parseFloat(test.criticalHigh) : undefined;

    if (critLow !== undefined && numericValue <= critLow) {
      flag = ResultFlag.CRITICAL_LOW;
      isAbnormal = true;
      isCritical = true;
    } else if (critHigh !== undefined && numericValue >= critHigh) {
      flag = ResultFlag.CRITICAL_HIGH;
      isAbnormal = true;
      isCritical = true;
    } else if (reference.min !== undefined && numericValue < reference.min) {
      flag = ResultFlag.ABNORMAL_LOW;
      isAbnormal = true;
    } else if (reference.max !== undefined && numericValue > reference.max) {
      flag = ResultFlag.ABNORMAL_HIGH;
      isAbnormal = true;
    }

    return { flag, isAbnormal, isCritical };
  }

  private async compareWithHistory(patientId: string, testId: string, numericValue: number | undefined): Promise<string | null> {
    if (numericValue === undefined) return null;

    const history = await prisma.testResult.findMany({
      where: {
        sample: { patientId },
        testId,
        numericValue: { not: null },
        createdAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { numericValue: true, createdAt: true },
    });

    if (history.length === 0) return null;

    const prevValues = history.map(r => parseFloat(r.numericValue!.toString()));
    const avg = prevValues.reduce((a, b) => a + b, 0) / prevValues.length;
    const diffPercent = Math.abs((numericValue - avg) / avg) * 100;

    if (diffPercent > 50) {
      return `与过去30天均值偏差${diffPercent.toFixed(1)}%，历史均值: ${avg.toFixed(2)}`;
    }
    if (diffPercent > 30) {
      return `与过去30天均值偏差${diffPercent.toFixed(1)}%，需关注`;
    }
    return null;
  }

  async uploadResult(input: UploadResultInput) {
    const sample = await prisma.sample.findUnique({
      where: { id: input.sampleId },
      include: { patient: true, testTasks: { where: { testId: input.testId } } },
    });

    if (!sample) {
      throw new NotFoundError('样本不存在');
    }

    const test = await prisma.labTest.findUnique({
      where: { id: input.testId },
    });

    if (!test) {
      throw new NotFoundError('检测项目不存在');
    }

    const evaluation = this.evaluateResultFlag(input.resultValue, input.numericValue, test);
    const historicalDiff = await this.compareWithHistory(sample.patientId, input.testId, input.numericValue);

    if (input.taskId) {
      const task = await prisma.testTask.findUnique({
        where: { id: input.taskId },
      });

      if (!task) {
        throw new NotFoundError('检测任务不存在');
      }

      if (task.sampleId !== input.sampleId) {
        throw new AppError(`任务 ${input.taskId} 不属于当前样本（任务样本: ${task.sampleId}，传入样本: ${input.sampleId}）`, 400);
      }

      if (task.testId !== input.testId) {
        throw new AppError(`任务 ${input.taskId} 不属于当前检测项目（任务项目: ${task.testId}，传入项目: ${input.testId}）`, 400);
      }

      if (task.status !== 'ASSIGNED' && task.status !== 'IN_PROGRESS') {
        throw new AppError(`任务 ${input.taskId} 当前状态为 ${task.status}，仅已分配(ASSIGNED)或进行中(IN_PROGRESS)的任务可上传结果`, 400);
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const testResult = await tx.testResult.create({
        data: {
          sampleId: input.sampleId,
          taskId: input.taskId,
          testId: input.testId,
          resultValue: input.resultValue,
          numericValue: input.numericValue,
          unit: input.unit || test.unit,
          flag: evaluation.flag,
          isAbnormal: evaluation.isAbnormal,
          isCritical: evaluation.isCritical,
          referenceRange: test.referenceRange,
          testedBy: input.testedBy,
          testedAt: new Date(),
          historicalDiff,
        },
        include: {
          labTest: true,
          sample: { include: { patient: true, department: true } },
        },
      });

      if (input.taskId) {
        const task = await tx.testTask.update({
          where: { id: input.taskId },
          data: { status: 'COMPLETED', completedAt: new Date() },
          select: { deviceId: true },
        });

        if (task.deviceId) {
          await tx.device.update({
            where: { id: task.deviceId },
            data: { currentLoad: { decrement: 1 } },
          });
        }
      }

      const remaining = await tx.testTask.count({
        where: {
          sampleId: input.sampleId,
          status: { not: 'COMPLETED' },
        },
      });

      if (remaining === 0) {
        await tx.sample.update({
          where: { id: input.sampleId },
          data: {
            status: SampleStatus.ANALYZED,
            analysisEndTime: new Date(),
          },
        });
      }

      if (evaluation.isAbnormal && historicalDiff?.includes('50')) {
        await this.createRecheckWorkOrder(tx, sample, testResult, historicalDiff);
      }

      return testResult;
    });

    await this.notifyResultUploaded(result, sample, evaluation, historicalDiff);

    return {
      result,
      evaluation,
      historicalDiff,
      recheckRequired: evaluation.isAbnormal && (historicalDiff?.includes('50') || false),
    };
  }

  private async createRecheckWorkOrder(tx: any, sample: Sample, testResult: any, reason: string) {
    const director = await tx.user.findFirst({
      where: {
        departmentId: sample.departmentId,
        role: 'LAB_DIRECTOR',
        isActive: true,
      },
    });

    const order = await tx.workOrder.create({
      data: {
        type: WorkOrderType.RECHECK,
        title: `复检工单 - ${testResult.labTest.name}`,
        description: `检测结果异常触发复检：${reason}。样本号：${sample.sampleNo}，检测项目：${testResult.labTest.name}，结果：${testResult.resultValue}${testResult.unit || ''}`,
        assignedToId: director?.id,
        createdById: 'system',
        departmentId: sample.departmentId,
        status: WorkOrderStatus.PENDING,
        priority: 80,
        dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });

    if (director) {
      wsManager.sendToUser(director.id, 'workorder:new', {
        type: 'RECHECK_WORKORDER',
        workOrderId: order.id,
        title: order.title,
        sampleNo: sample.sampleNo,
        testName: testResult.labTest.name,
        priority: order.priority,
        timestamp: new Date().toISOString(),
      });
    }

    return order;
  }

  private async notifyResultUploaded(result: any, sample: any, evaluation: any, historicalDiff: string | null) {
    const staff = await prisma.user.findMany({
      where: {
        departmentId: sample.departmentId,
        isActive: true,
        role: { in: ['LAB_TECHNICIAN', 'LAB_DIRECTOR'] },
      },
      select: { id: true },
    });

    const eventData = {
      type: 'RESULT_UPLOADED',
      resultId: result.id,
      sampleId: sample.id,
      sampleNo: sample.sampleNo,
      patientName: sample.patient.name,
      testName: result.labTest.name,
      resultValue: result.resultValue,
      unit: result.unit,
      flag: evaluation.flag,
      isAbnormal: evaluation.isAbnormal,
      isCritical: evaluation.isCritical,
      historicalDiff,
      timestamp: new Date().toISOString(),
    };

    wsManager.sendToUsers(staff.map(s => s.id), 'result:uploaded', eventData);

    if (sample.requisitionId) {
      const req = await prisma.requisitionOrder.findUnique({
        where: { id: sample.requisitionId },
        select: { orderedById: true },
      });
      if (req?.orderedById) {
        wsManager.sendToUser(req.orderedById, 'patient:result', eventData);
      }
    }
  }

  async getSampleResults(sampleId: string) {
    const sample = await prisma.sample.findUnique({
      where: { id: sampleId },
      include: {
        patient: { select: { name: true, mrn: true, gender: true, birthDate: true } },
        testResults: {
          include: { labTest: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!sample) {
      throw new NotFoundError('样本不存在');
    }

    return sample;
  }

  async getAbnormalResults(params: {
    departmentId?: string;
    criticalOnly?: boolean;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { departmentId, criticalOnly, startDate, endDate, page = 1, pageSize = 50 } = params;

    const where: any = {
      isAbnormal: true,
    };
    if (criticalOnly) where.isCritical = true;
    if (departmentId) where.sample = { departmentId };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [total, results] = await Promise.all([
      prisma.testResult.count({ where }),
      prisma.testResult.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [
          { isCritical: 'desc' },
          { createdAt: 'desc' },
        ],
        include: {
          labTest: { select: { name: true, code: true } },
          sample: {
            include: {
              patient: { select: { name: true, mrn: true } },
              department: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      data: results,
    };
  }
}

export const resultUploadService = new ResultUploadService();
