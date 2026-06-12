import prisma from '../lib/prisma';
import { SampleType, UrgencyLevel, SampleStatus, LabTest } from '@prisma/client';
import { ValidationError, NotFoundError } from '../middleware/error';
import { wsManager } from '../lib/ws';
import logger from '../lib/logger';

const REQUIRED_SAMPLE_FIELDS: Record<SampleType, string[]> = {
  [SampleType.BLOOD]: ['volume', 'collectionTime', 'collectionSite', 'collector'],
  [SampleType.URINE]: ['volume', 'collectionTime', 'collector'],
  [SampleType.STOOL]: ['collectionTime', 'collector'],
  [SampleType.SPUTUM]: ['collectionTime', 'collector'],
  [SampleType.CEREBROSPINAL]: ['volume', 'collectionTime', 'collectionSite', 'collector'],
  [SampleType.PLEURAL]: ['volume', 'collectionTime', 'collectionSite', 'collector'],
  [SampleType.ASCITIC]: ['volume', 'collectionTime', 'collectionSite', 'collector'],
  [SampleType.OTHER]: ['collectionTime', 'collector'],
};

export interface CreateSampleInput {
  patientId: string;
  requisitionId?: string;
  sampleType: SampleType;
  urgency?: UrgencyLevel;
  volume?: string;
  collectionTime?: Date;
  collectionSite?: string;
  collector?: string;
  testIds: string[];
}

class SampleReceptionService {
  private generateSampleNo(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `S${dateStr}${random}`;
  }

  validateSampleCompleteness(sampleType: SampleType, data: Partial<CreateSampleInput>): string[] {
    const required = REQUIRED_SAMPLE_FIELDS[sampleType] || [];
    const missing: string[] = [];
    for (const field of required) {
      if (!(data as any)[field]) {
        missing.push(field);
      }
    }
    return missing;
  }

  async determineDepartment(testIds: string[]): Promise<{ departmentId: string; tests: LabTest[] }> {
    const tests = await prisma.labTest.findMany({
      where: { id: { in: testIds }, isActive: true },
      include: { department: true },
    });

    if (tests.length === 0) {
      throw new NotFoundError('未找到有效的检测项目');
    }

    const departments = new Map<string, number>();
    for (const test of tests) {
      const count = departments.get(test.departmentId) || 0;
      departments.set(test.departmentId, count + 1);
    }

    let maxDeptId = '';
    let maxCount = 0;
    for (const [deptId, count] of departments.entries()) {
      if (count > maxCount) {
        maxCount = count;
        maxDeptId = deptId;
      }
    }

    const unmatched = tests.filter(t => t.departmentId !== maxDeptId);
    if (unmatched.length > 0) {
      logger.warn(`部分检测项目不属于主分配科室: ${unmatched.map(t => t.code).join(',')}`);
    }

    return { departmentId: maxDeptId, tests };
  }

  async receiveSample(input: CreateSampleInput, receivedById: string) {
    const patient = await prisma.patient.findUnique({
      where: { id: input.patientId },
    });
    if (!patient) {
      throw new NotFoundError('患者不存在');
    }

    const missingItems = this.validateSampleCompleteness(input.sampleType, input);
    const { departmentId, tests } = await this.determineDepartment(input.testIds);

    const sampleNo = this.generateSampleNo();
    const isIncomplete = missingItems.length > 0;

    const sample = await prisma.sample.create({
      data: {
        sampleNo,
        patientId: input.patientId,
        requisitionId: input.requisitionId,
        sampleType: input.sampleType,
        urgency: input.urgency || UrgencyLevel.ROUTINE,
        status: isIncomplete ? SampleStatus.REJECTED : SampleStatus.RECEIVED,
        receivedById,
        departmentId,
        volume: input.volume,
        collectionTime: input.collectionTime,
        collectionSite: input.collectionSite,
        collector: input.collector,
        rejectionReason: isIncomplete ? '样本信息不完整' : null,
        missingItems: isIncomplete ? missingItems as any : undefined,
        assignedAt: isIncomplete ? null : new Date(),
      },
      include: {
        patient: true,
        department: true,
        requisition: { include: { orderedBy: true } },
      },
    });

    if (!isIncomplete) {
      await prisma.$transaction(
        input.testIds.map(testId =>
          prisma.testTask.create({
            data: {
              sampleId: sample.id,
              testId,
              priority: this.getPriority(input.urgency || UrgencyLevel.ROUTINE),
              status: 'PENDING',
            },
          })
        )
      );
    }

    await this.notifyReception(sample, tests, isIncomplete, missingItems);

    return {
      sample,
      isIncomplete,
      missingItems,
      assignedDepartment: (sample as any).department?.name,
      tests: tests.map(t => ({ code: t.code, name: t.name })),
    };
  }

  private getPriority(urgency: UrgencyLevel): number {
    switch (urgency) {
      case UrgencyLevel.CRITICAL: return 100;
      case UrgencyLevel.EMERGENCY: return 80;
      case UrgencyLevel.URGENT: return 50;
      default: return 0;
    }
  }

  private async notifyReception(sample: any, tests: LabTest[], isIncomplete: boolean, missingItems: string[]) {
    if (sample.departmentId) {
      const staff = await prisma.user.findMany({
        where: {
          departmentId: sample.departmentId,
          isActive: true,
          role: { in: ['LAB_TECHNICIAN', 'LAB_DIRECTOR'] },
        },
        select: { id: true },
      });

      const eventData = {
        type: 'SAMPLE_RECEPTION',
        sampleId: sample.id,
        sampleNo: sample.sampleNo,
        patientName: sample.patient.name,
        status: sample.status,
        isIncomplete,
        missingItems,
        tests: tests.map(t => t.name),
        timestamp: new Date().toISOString(),
      };

      wsManager.sendToUsers(staff.map(s => s.id), 'sample:reception', eventData);
    }

    if (sample.requisition?.orderedById) {
      wsManager.sendToUser(sample.requisition.orderedById, 'sample:status', {
        type: 'SAMPLE_STATUS',
        sampleId: sample.id,
        sampleNo: sample.sampleNo,
        status: sample.status,
        isIncomplete,
        missingItems,
        timestamp: new Date().toISOString(),
      });
    }
  }

  async getSamples(params: {
    status?: SampleStatus;
    departmentId?: string;
    patientId?: string;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { status, departmentId, patientId, startDate, endDate, page = 1, pageSize = 20 } = params;

    const where: any = {};
    if (status) where.status = status;
    if (departmentId) where.departmentId = departmentId;
    if (patientId) where.patientId = patientId;
    if (startDate || endDate) {
      where.receivedAt = {};
      if (startDate) where.receivedAt.gte = startDate;
      if (endDate) where.receivedAt.lte = endDate;
    }

    const [total, samples] = await Promise.all([
      prisma.sample.count({ where }),
      prisma.sample.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { receivedAt: 'desc' },
        include: {
          patient: { select: { name: true, mrn: true } },
          department: { select: { name: true } },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      pages: Math.ceil(total / pageSize),
      data: samples,
    };
  }

  async getSampleDetail(sampleId: string) {
    const sample = await prisma.sample.findUnique({
      where: { id: sampleId },
      include: {
        patient: true,
        department: true,
        requisition: { include: { orderedBy: true, items: { include: { labTest: true } } } },
        testTasks: { include: { labTest: true, device: true } },
        testResults: { include: { labTest: true } },
        report: true,
      },
    });

    if (!sample) {
      throw new NotFoundError('样本不存在');
    }

    return sample;
  }
}

export const sampleReceptionService = new SampleReceptionService();
