import prisma from '../lib/prisma';
import { ReportStatus, SampleStatus, NotificationLevel, NotificationStatus } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';
import logger from '../lib/logger';
import { wsManager } from '../lib/ws';

class ReportDistributionService {
  async distributeReport(reportId: string, operatorId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: {
        sample: {
          include: {
            patient: true,
            requisition: { include: { orderedBy: true } },
            department: true,
          },
        },
        department: true,
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

    if (report.isLocked) {
      throw new AppError('报告已被危急值锁定，需先确认危急值后才能分发', 400);
    }

    if (report.status === ReportStatus.LOCKED) {
      throw new AppError('报告处于锁定状态，无法分发', 400);
    }

    if (report.status !== ReportStatus.APPROVED) {
      throw new AppError('仅审核通过的报告可以分发', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      const updatedReport = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.DISTRIBUTED,
          distributedAt: now,
        },
        include: {
          sample: {
            include: {
              patient: true,
              requisition: { include: { orderedBy: true } },
              testResults: { include: { labTest: true } },
            },
          },
        },
      });

      await tx.sample.update({
        where: { id: report.sampleId },
        data: { status: SampleStatus.REPORTED },
      });

      await this.notifyDistribution(tx, updatedReport);

      return updatedReport;
    });
  }

  private async notifyDistribution(tx: any, report: any) {
    const recipients: string[] = [];

    if (report.sample.requisition?.orderedBy) {
      recipients.push(report.sample.requisition.orderedById);
    }

    const patientDeptUsers = await tx.user.findMany({
      where: {
        role: { in: ['CLINICIAN', 'DEPARTMENT_HEAD'] },
        isActive: true,
      },
      select: { id: true },
    });
    (patientDeptUsers as any[]).forEach((u: any) => recipients.push(u.id));

    const uniqueRecipients = [...new Set(recipients)];

    const reportData = {
      type: 'REPORT_DISTRIBUTED',
      reportId: report.id,
      reportNo: report.reportNo,
      patientName: report.sample.patient.name,
      patientMrn: report.sample.patient.mrn,
      sampleNo: report.sample.sampleNo,
      departmentName: report.department?.name,
      hasCritical: report.hasCritical,
      timestamp: new Date().toISOString(),
    };

    wsManager.sendToUsers(uniqueRecipients, 'report:distributed', reportData);

    await tx.notification.createMany({
      data: uniqueRecipients.map(recipientId => ({
        type: 'REPORT_AVAILABLE',
        title: `检验报告已发布 - ${report.reportNo}`,
        content: `患者${report.sample.patient.name}的检验报告已审核通过，请查看。${report.hasCritical ? '【含危急值】' : ''}`,
        level: NotificationLevel.LEVEL_1,
        status: NotificationStatus.SENT,
        reportId: report.id,
        recipientId,
        sentAt: new Date(),
      })),
    });
  }

  async archiveReport(reportId: string) {
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new NotFoundError('报告不存在');
    }
    if (report.status !== ReportStatus.DISTRIBUTED) {
      throw new AppError('仅已分发的报告可以归档', 400);
    }

    const now = new Date();

    return await prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          status: ReportStatus.ARCHIVED,
          archivedAt: now,
        },
      });

      await tx.sample.update({
        where: { id: report.sampleId },
        data: {
          status: SampleStatus.ARCHIVED,
          archivedAt: now,
        },
      });

      return updated;
    });
  }

  async autoArchiveDistributedReports() {
    const threshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const reports = await prisma.report.findMany({
      where: {
        status: ReportStatus.DISTRIBUTED,
        distributedAt: { lte: threshold },
      },
      select: { id: true, sampleId: true },
    });

    const now = new Date();

    await prisma.$transaction([
      prisma.report.updateMany({
        where: { id: { in: reports.map(r => r.id) } },
        data: {
          status: ReportStatus.ARCHIVED,
          archivedAt: now,
        },
      }),
      prisma.sample.updateMany({
        where: { id: { in: reports.map(r => r.sampleId) } },
        data: {
          status: SampleStatus.ARCHIVED,
          archivedAt: now,
        },
      }),
    ]);

    return { archived: reports.length };
  }

  async getPatientReports(patientId: string, params?: {
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { startDate, endDate, page = 1, pageSize = 20 } = params || {};

    const where: any = {
      patientId,
      status: { in: [ReportStatus.DISTRIBUTED, ReportStatus.ARCHIVED] },
    };
    if (startDate || endDate) {
      where.approvedAt = {};
      if (startDate) where.approvedAt.gte = startDate;
      if (endDate) where.approvedAt.lte = endDate;
    }

    const [total, reports] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { approvedAt: 'desc' },
        include: {
          department: { select: { name: true } },
          sample: {
            include: {
              testResults: {
                include: { labTest: true },
                orderBy: { createdAt: 'asc' },
              },
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      data: reports,
    };
  }
}

export const reportDistributionService = new ReportDistributionService();
