import prisma from '../lib/prisma';
import { ReportStatus, SampleStatus, WorkOrderType, WorkOrderStatus, ResultFlag, NotificationLevel, NotificationStatus } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';
import logger from '../lib/logger';
import { wsManager } from '../lib/ws';

class ReportService {
  private generateReportNo(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `R${dateStr}${random}`;
  }

  private validateLogic(testResults: any[]): {
    passed: boolean;
    errors: string[];
    contradictions: { test1: string; test2: string; type: string; blocking: boolean }[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const contradictions: { test1: string; test2: string; type: string; blocking: boolean }[] = [];
    const warnings: string[] = [];

    const resultMap = new Map<string, any>();
    for (const r of testResults) {
      resultMap.set(r.labTest.code, r);
    }

    this.checkContradictions(resultMap, contradictions, warnings);
    this.checkReferenceRange(testResults, errors);
    this.checkDeltaCheck(testResults, errors);

    const blockingContradictions = contradictions.filter(c => c.blocking);
    const passed = errors.length === 0 && blockingContradictions.length === 0;

    return { passed, errors, contradictions, warnings };
  }

  private checkContradictions(
    resultMap: Map<string, any>,
    contradictions: { test1: string; test2: string; type: string; blocking: boolean }[],
    warnings: string[]
  ) {
    const getNumeric = (r: any) => {
      if (r?.numericValue !== undefined && r.numericValue !== null) {
        return parseFloat(r.numericValue.toString());
      }
      return undefined;
    };

    const rules: {
      cond1: { code: string; pred: (v: any) => boolean };
      cond2: { code: string; pred: (v: any) => boolean };
      type: string;
      blocking: boolean;
    }[] = [
      {
        cond1: {
          code: 'HBsAg',
          pred: (r) => r && !r.isAbnormal,
        },
        cond2: {
          code: 'HBsAb',
          pred: (r) => r && r.isAbnormal,
        },
        type: '乙肝表面抗原阴性与表面抗体阳性同时存在（免疫后常见正常现象，建议结合临床）',
        blocking: false,
      },
      {
        cond1: {
          code: 'HBsAg',
          pred: (r) => r && r.isAbnormal,
        },
        cond2: {
          code: 'HBsAb',
          pred: (r) => r && r.isAbnormal,
        },
        type: '乙肝表面抗原阳性（感染）与表面抗体阳性（免疫）同时存在，需复核',
        blocking: true,
      },
      {
        cond1: {
          code: 'WBC',
          pred: (r) => {
            const v = getNumeric(r);
            return v !== undefined && v < 4;
          },
        },
        cond2: {
          code: 'NEUT_PCT',
          pred: (r) => {
            const v = getNumeric(r);
            return v !== undefined && v > 70;
          },
        },
        type: '白细胞减少与中性粒细胞百分比升高存在矛盾，需复核',
        blocking: true,
      },
      {
        cond1: {
          code: 'HGB',
          pred: (r) => {
            const v = getNumeric(r);
            return v !== undefined && v < 100;
          },
        },
        cond2: {
          code: 'MCV',
          pred: (r) => {
            const v = getNumeric(r);
            return v !== undefined && v > 100;
          },
        },
        type: '血红蛋白降低（贫血）伴红细胞体积升高，提示大细胞性贫血可能，建议结合临床',
        blocking: false,
      },
    ];

    for (const rule of rules) {
      const r1 = resultMap.get(rule.cond1.code);
      const r2 = resultMap.get(rule.cond2.code);
      if (r1 && r2 && rule.cond1.pred(r1) && rule.cond2.pred(r2)) {
        contradictions.push({
          test1: rule.cond1.code,
          test2: rule.cond2.code,
          type: rule.type,
          blocking: rule.blocking,
        });
        if (!rule.blocking) {
          warnings.push(rule.type);
        }
      }
    }
  }

  private checkReferenceRange(testResults: any[], errors: string[]) {
    for (const result of testResults) {
      if (result.flag === ResultFlag.INCONCLUSIVE) {
        errors.push(`${result.labTest.name}: 结果值无法判定`);
      }
    }
  }

  private checkDeltaCheck(testResults: any[], errors: string[]) {
    for (const result of testResults) {
      if (result.historicalDiff && result.historicalDiff.includes('50')) {
        errors.push(`${result.labTest.name}: ${result.historicalDiff}`);
      }
    }
  }

  async generateReport(sampleId: string, createdById: string) {
    const sample = await prisma.sample.findUnique({
      where: { id: sampleId },
      include: {
        patient: true,
        department: true,
        requisition: { include: { orderedBy: true } },
        testResults: {
          include: { labTest: true },
          where: { isRecheck: false },
        },
      },
    });

    if (!sample) {
      throw new NotFoundError('样本不存在');
    }

    if (sample.testResults.length === 0) {
      throw new AppError('样本尚无检测结果，无法生成报告', 400);
    }

    const existing = await prisma.report.findUnique({ where: { sampleId } });
    if (existing) {
      return existing;
    }

    const validation = this.validateLogic(sample.testResults);
    const hasCritical = sample.testResults.some(r => r.isCritical);

    const reportNo = this.generateReportNo();
    const now = new Date();

    const report = await prisma.$transaction(async (tx) => {
      const newReport = await tx.report.create({
        data: {
          reportNo,
          sampleId,
          patientId: sample.patientId,
          departmentId: sample.departmentId!,
          status: hasCritical ? ReportStatus.LOCKED : (validation.passed ? ReportStatus.PENDING_REVIEW : ReportStatus.DRAFT),
          isLocked: hasCritical,
          hasCritical,
          validationErrors: {
            passed: validation.passed,
            errors: validation.errors,
            contradictions: validation.contradictions,
            warnings: validation.warnings,
          },
          generatedAt: now,
        },
        include: {
          patient: true,
          department: true,
          sample: { include: { testResults: { include: { labTest: true } } } },
        },
      });

      await tx.sample.update({
        where: { id: sampleId },
        data: {
          status: SampleStatus.REPORTING,
          report: { connect: { id: newReport.id } },
        },
      });

      if (!validation.passed) {
        await this.createQCWorkOrder(tx, sample, newReport, validation);
      }

      if (hasCritical) {
        await this.createCriticalNotifications(tx, sample, newReport);
      }

      return newReport;
    });

    await this.notifyReportGenerated(report, sample, validation, hasCritical);

    return {
      report,
      validation,
      hasCritical,
    };
  }

  private async createQCWorkOrder(tx: any, sample: any, report: any, validation: any) {
    const director = await tx.user.findFirst({
      where: {
        departmentId: sample.departmentId,
        role: 'LAB_DIRECTOR',
        isActive: true,
      },
    });

    const blockingContradictions = validation.contradictions.filter((c: any) => c.blocking);
    const nonBlockingContradictions = validation.contradictions.filter((c: any) => !c.blocking);

    let description = '报告逻辑校验未通过：\n';
    if (validation.errors.length > 0) {
      description += `错误：${validation.errors.join('\n')}\n`;
    }
    if (blockingContradictions.length > 0) {
      description += `阻断性矛盾：${blockingContradictions.map((c: any) => c.type).join('\n')}\n`;
    }
    if (nonBlockingContradictions.length > 0) {
      description += `提示性矛盾（不阻断审核）：${nonBlockingContradictions.map((c: any) => c.type).join('\n')}\n`;
    }

    const order = await tx.workOrder.create({
      data: {
        type: WorkOrderType.QC,
        title: `质控工单 - ${report.reportNo}`,
        description,
        reportId: report.id,
        assignedToId: director?.id,
        createdById: 'system',
        departmentId: sample.departmentId,
        status: WorkOrderStatus.PENDING,
        priority: 90,
        dueDate: new Date(Date.now() + 4 * 60 * 60 * 1000),
      },
    });

    if (director) {
      wsManager.sendToUser(director.id, 'workorder:new', {
        type: 'QC_WORKORDER',
        workOrderId: order.id,
        title: order.title,
        reportNo: report.reportNo,
        errors: validation.errors.length,
        contradictions: validation.contradictions.length,
        timestamp: new Date().toISOString(),
      });
    }

    return order;
  }

  private async createCriticalNotifications(tx: any, sample: any, report: any) {
    const criticalItems = sample.testResults
      .filter((r: any) => r.isCritical)
      .map((r: any) => ({
        testName: r.labTest.name,
        value: r.resultValue,
        unit: r.unit,
        flag: r.flag,
      }));

    if (criticalItems.length === 0) return;

    const level1Recipients: string[] = [];
    if (sample.requisition?.orderedBy) {
      level1Recipients.push(sample.requisition.orderedById);
    }

    const notificationData = {
      reportId: report.id,
      reportNo: report.reportNo,
      patientName: sample.patient.name,
      patientMrn: sample.patient.mrn,
      criticalItems,
      sampleNo: sample.sampleNo,
      departmentName: report.department?.name || sample.department?.name,
    };

    for (const recipientId of level1Recipients) {
      const title = '【危急值一级通知】请立即处理';
      const content = `患者 ${notificationData.patientName} (${notificationData.patientMrn}) 的检验报告出现危急值，涉及项目：${criticalItems.map((i: any) => `${i.testName}:${i.value}${i.unit || ''}`).join('; ')}。请立即确认。`;

      const notification = await tx.notification.create({
        data: {
          type: 'CRITICAL_VALUE',
          title,
          content,
          level: NotificationLevel.LEVEL_1,
          status: NotificationStatus.SENT,
          reportId: report.id,
          recipientId,
          sentAt: new Date(),
        },
      });

      wsManager.sendToUser(recipientId, 'critical:alert', {
        type: 'CRITICAL_ALERT',
        notificationId: notification.id,
        level: NotificationLevel.LEVEL_1,
        title,
        content,
        reportId: report.id,
        reportNo: report.reportNo,
        patientName: notificationData.patientName,
        criticalItems,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info(`报告 ${report.reportNo} 生成时检测到危急值，已自动发送${level1Recipients.length}条一级通知`);
  }

  private async notifyReportGenerated(report: any, sample: any, validation: any, hasCritical: boolean) {
    const staff = await prisma.user.findMany({
      where: {
        departmentId: sample.departmentId,
        isActive: true,
        role: { in: ['LAB_DIRECTOR'] },
      },
      select: { id: true },
    });

    const eventData = {
      type: 'REPORT_GENERATED',
      reportId: report.id,
      reportNo: report.reportNo,
      sampleNo: sample.sampleNo,
      patientName: sample.patient.name,
      status: report.status,
      validationPassed: validation.passed,
      errorsCount: validation.errors.length,
      contradictionsCount: validation.contradictions.length,
      hasCritical,
      isLocked: report.isLocked,
      timestamp: new Date().toISOString(),
    };

    wsManager.sendToUsers(staff.map(s => s.id), 'report:generated', eventData);
  }

  async reviewReport(reportId: string, reviewerId: string, action: 'APPROVE' | 'REJECT', comment?: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: {
        sample: { include: { patient: true } },
        department: true,
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

    if (report.isLocked) {
      throw new AppError('报告已被危急值锁定，需先确认危急值通知解锁后才能审核', 400);
    }

    if (report.status === ReportStatus.LOCKED) {
      throw new AppError('报告处于锁定状态，需先确认危急值通知解锁后才能审核', 400);
    }

    if (report.status === ReportStatus.DRAFT) {
      throw new AppError('草稿报告需先修正后才能审核', 400);
    }

    if (report.status !== ReportStatus.PENDING_REVIEW) {
      throw new AppError(`报告状态不允许审核（当前状态：${report.status}）`, 400);
    }

    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();

      if (action === 'APPROVE') {
        const updated = await tx.report.update({
          where: { id: reportId },
          data: {
            status: ReportStatus.APPROVED,
            reviewedById: reviewerId,
            reviewedAt: now,
            approvedAt: now,
          },
          include: {
            patient: true,
            sample: { include: { testResults: { include: { labTest: true } } } },
          },
        });

        await tx.sample.update({
          where: { id: report.sampleId },
          data: { status: SampleStatus.REPORTED },
        });

        return { report: updated, action };
      } else {
        const updated = await tx.report.update({
          where: { id: reportId },
          data: {
            status: ReportStatus.DRAFT,
          },
        });

        await tx.workOrder.create({
          data: {
            type: WorkOrderType.QC,
            title: `报告驳回修正 - ${report.reportNo}`,
            description: `审核驳回，原因：${comment || '未说明'}`,
            reportId: report.id,
            createdById: reviewerId,
            departmentId: report.departmentId,
            status: WorkOrderStatus.PENDING,
            priority: 85,
            dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000),
          },
        });

        return { report: updated, action, comment };
      }
    });

    await this.notifyReportReviewed(report, result.action);
    return result;
  }

  private async notifyReportReviewed(report: any, action: string) {
    const technicians = await prisma.user.findMany({
      where: {
        departmentId: report.departmentId,
        isActive: true,
        role: { in: ['LAB_TECHNICIAN'] },
      },
      select: { id: true },
    });

    wsManager.sendToUsers(technicians.map(t => t.id), 'report:reviewed', {
      type: 'REPORT_REVIEWED',
      reportId: report.id,
      reportNo: report.reportNo,
      action,
      timestamp: new Date().toISOString(),
    });
  }

  async getReport(reportId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: {
        patient: true,
        department: true,
        sample: {
          include: {
            testResults: { include: { labTest: true } },
            requisition: { include: { orderedBy: true } },
          },
        },
        reviewedBy: { select: { name: true, role: true } },
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

    let criticalLockInfo: any = null;
    if (report.hasCritical) {
      const notifications = await prisma.notification.findMany({
        where: { reportId, type: 'CRITICAL_VALUE' },
        orderBy: { sentAt: 'asc' },
        include: {
          recipient: { select: { id: true, name: true, role: true } },
          confirmedBy: { select: { id: true, name: true, role: true } },
          escalatedTo: {
            include: {
              recipient: { select: { name: true, role: true } },
              confirmedBy: { select: { name: true, role: true } },
            },
          },
          escalatedFrom: {
            include: { recipient: { select: { name: true } } },
          },
        },
      });

      const level1 = notifications.filter(n => n.level === NotificationLevel.LEVEL_1);
      const level2 = notifications.filter(n => n.level === NotificationLevel.LEVEL_2);
      const level3 = notifications.filter(n => n.level === NotificationLevel.LEVEL_3);
      const level1NotConfirmed = level1.filter(n => !n.confirmedAt);
      const level1Confirmed = level1.filter(n => n.confirmedAt);
      const level1Escalated = level1.filter(n => n.status === NotificationStatus.ESCALATED);

      criticalLockInfo = {
        summary: {
          totalLevel1: level1.length,
          level1NotConfirmed: level1NotConfirmed.length,
          level1Confirmed: level1Confirmed.length,
          level1Escalated: level1Escalated.length,
          level2Count: level2.length,
          level3Count: level3.length,
          allLevel1Confirmed: level1.length > 0 && level1NotConfirmed.length === 0,
        },
        level1NotConfirmed: level1NotConfirmed.map(n => ({
          id: n.id, recipient: n.recipient, sentAt: n.sentAt, status: n.status,
          isEscalated: n.status === NotificationStatus.ESCALATED,
          escalatedAt: (n as any).escalatedAt,
        })),
        level1Confirmed: level1Confirmed.map(n => ({
          id: n.id, recipient: n.recipient, sentAt: n.sentAt,
          confirmedAt: n.confirmedAt, confirmedBy: n.confirmedBy,
          isLate: n.status === NotificationStatus.ESCALATED,
          escalatedAt: (n as any).escalatedAt,
        })),
        escalationProcessed: [...level2, ...level3].map(n => ({
          id: n.id,
          level: n.level,
          recipient: n.recipient,
          sentAt: n.sentAt,
          status: n.status,
          confirmedAt: n.confirmedAt,
          confirmedBy: n.confirmedBy,
          escalatedFrom: (n as any).escalatedFrom
            ? { recipient: (n as any).escalatedFrom.recipient, notificationId: (n as any).escalatedFromId }
            : null,
        })),
      };
    }

    return { ...report as any, criticalLockInfo };
  }

  async getReports(params: {
    status?: ReportStatus;
    departmentId?: string;
    patientId?: string;
    startDate?: Date;
    endDate?: Date;
    hasCritical?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const {
      status, departmentId, patientId, startDate, endDate, hasCritical,
      page = 1, pageSize = 20,
    } = params;

    const where: any = {};
    if (status) where.status = status;
    if (departmentId) where.departmentId = departmentId;
    if (patientId) where.patientId = patientId;
    if (hasCritical !== undefined) where.hasCritical = hasCritical;
    if (startDate || endDate) {
      where.generatedAt = {};
      if (startDate) where.generatedAt.gte = startDate;
      if (endDate) where.generatedAt.lte = endDate;
    }

    const [total, reports] = await Promise.all([
      prisma.report.count({ where }),
      prisma.report.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { generatedAt: 'desc' },
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
      data: reports,
    };
  }

  async fixDraftReport(reportId: string, fixedById: string) {
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) {
      throw new NotFoundError('报告不存在');
    }
    if (report.isLocked) {
      throw new AppError('报告已被危急值锁定，无法提交审核', 400);
    }
    if (report.status === ReportStatus.LOCKED) {
      throw new AppError('报告处于锁定状态，无法提交审核', 400);
    }
    if (report.status !== ReportStatus.DRAFT) {
      throw new AppError('仅草稿报告可以提交审核', 400);
    }

    return await prisma.report.update({
      where: { id: reportId },
      data: {
        status: ReportStatus.PENDING_REVIEW,
        validationErrors: {
          ...(report.validationErrors as any),
          lastFixedBy: fixedById,
          lastFixedAt: new Date(),
        },
      },
    });
  }
}

export const reportService = new ReportService();
