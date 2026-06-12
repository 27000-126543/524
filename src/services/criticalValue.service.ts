import prisma from '../lib/prisma';
import { NotificationLevel, NotificationStatus, ReportStatus, UserRole } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';
import logger from '../lib/logger';
import { wsManager } from '../lib/ws';

const CRITICAL_TIMEOUT_MINUTES = parseInt(process.env.CRITICAL_TIMEOUT_MINUTES || '15', 10);

interface CriticalRecipients {
  level1: string[];
  level2: string[];
  level3: string[];
}

class CriticalValueService {
  async handleCriticalValueDetected(reportId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      include: {
        sample: {
          include: {
            patient: true,
            requisition: { include: { orderedBy: true } },
            testResults: {
              include: { labTest: true },
              where: { isCritical: true },
            },
          },
        },
        department: true,
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

    if (!report.hasCritical) {
      throw new AppError('该报告无危急值', 400);
    }

    const recipients = await this.getRecipients(report);
    const criticalItems = report.sample.testResults.map(r => ({
      testName: r.labTest.name,
      value: r.resultValue,
      unit: r.unit,
      flag: r.flag,
    }));

    return await this.sendCriticalNotifications(report, recipients, criticalItems);
  }

  private async getRecipients(report: any): Promise<CriticalRecipients> {
    const level1: string[] = [];
    const level2: string[] = [];
    const level3: string[] = [];

    if (report.sample.requisition?.orderedBy) {
      level1.push(report.sample.requisition.orderedById);
    }

    const deptHeads = await prisma.user.findMany({
      where: {
        departmentId: report.departmentId,
        role: UserRole.DEPARTMENT_HEAD,
        isActive: true,
      },
      select: { id: true },
    });
    deptHeads.forEach(u => level2.push(u.id));

    if (level2.length === 0) {
      const labDirs = await prisma.user.findMany({
        where: {
          departmentId: report.departmentId,
          role: UserRole.LAB_DIRECTOR,
          isActive: true,
        },
        select: { id: true },
      });
      labDirs.forEach(u => level2.push(u.id));
    }

    const medAffairs = await prisma.user.findMany({
      where: {
        role: UserRole.MEDICAL_AFFAIRS,
        isActive: true,
      },
      select: { id: true },
    });
    medAffairs.forEach(u => level3.push(u.id));

    return { level1, level2, level3 };
  }

  private async sendCriticalNotifications(
    report: any,
    recipients: CriticalRecipients,
    criticalItems: any[]
  ) {
    const now = new Date();
    const created: any[] = [];

    const notificationData = {
      reportId: report.id,
      reportNo: report.reportNo,
      patientName: report.sample.patient.name,
      patientMrn: report.sample.patient.mrn,
      criticalItems,
      sampleNo: report.sample.sampleNo,
      departmentName: report.department.name,
    };

    for (const recipientId of recipients.level1) {
      const n = await this.createNotification(
        recipientId, NotificationLevel.LEVEL_1, notificationData
      );
      created.push(n);
    }

    return {
      locked: report.isLocked,
      timeoutMinutes: CRITICAL_TIMEOUT_MINUTES,
      level1: recipients.level1.length,
      level2: recipients.level2.length,
      level3: recipients.level3.length,
      notificationsCreated: created.length,
      reportId: report.id,
    };
  }

  private async createNotificationWithEscalation(
    recipientId: string,
    level: NotificationLevel,
    data: any,
    escalatedFromId: string
  ) {
    const notification = await this.createNotification(recipientId, level, data);
    await prisma.notification.update({
      where: { id: notification.id },
      data: { escalatedFromId },
    });
    return notification;
  }

  private async createNotification(
    recipientId: string,
    level: NotificationLevel,
    data: any
  ) {
    const titles = {
      [NotificationLevel.LEVEL_1]: '【危急值一级通知】请立即处理',
      [NotificationLevel.LEVEL_2]: '【危急值二级通知】请关注',
      [NotificationLevel.LEVEL_3]: '【危急值三级通知】已升级至医务科',
    };

    const contents = {
      [NotificationLevel.LEVEL_1]: `患者 ${data.patientName} (${data.patientMrn}) 的检验报告出现危急值，涉及项目：${data.criticalItems.map((i: any) => `${i.testName}:${i.value}${i.unit || ''}`).join('; ')}。请立即确认。`,
      [NotificationLevel.LEVEL_2]: `危急值二级通知：患者 ${data.patientName} 的报告 ${data.reportNo} 存在危急值，一级通知超时未确认。`,
      [NotificationLevel.LEVEL_3]: `危急值三级通知：患者 ${data.patientName} 的报告 ${data.reportNo} 危急值已升级至医务科，请立即介入处理。`,
    };

    const notification = await prisma.notification.create({
      data: {
        type: 'CRITICAL_VALUE',
        title: titles[level],
        content: contents[level],
        level,
        status: NotificationStatus.SENT,
        reportId: data.reportId,
        recipientId,
        sentAt: new Date(),
      },
    });

    wsManager.sendToUser(recipientId, 'critical:alert', {
      type: 'CRITICAL_ALERT',
      notificationId: notification.id,
      level,
      title: titles[level],
      content: contents[level],
      reportId: data.reportId,
      reportNo: data.reportNo,
      patientName: data.patientName,
      criticalItems: data.criticalItems,
      timestamp: new Date().toISOString(),
    });

    return notification;
  }

  async confirmCriticalNotification(notificationId: string, confirmerId: string) {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      include: { report: true, recipient: { select: { name: true, role: true } } },
    });

    if (!notification) {
      throw new NotFoundError('通知不存在');
    }

    if (notification.recipientId !== confirmerId) {
      throw new AppError(`仅通知接收人（${notification.recipient?.name || notification.recipientId}）可确认此危急值通知`, 403);
    }

    if (notification.confirmedAt) {
      return notification;
    }

    const now = new Date();
    const wasEscalated = notification.status === NotificationStatus.ESCALATED;

    let updateData: any = {
      confirmedAt: now,
      confirmedById: confirmerId,
    };

    if (!wasEscalated) {
      updateData.status = NotificationStatus.CONFIRMED;
    }

    const confirmed = await prisma.notification.update({
      where: { id: notificationId },
      data: updateData,
    });

    if (notification.reportId && notification.level === NotificationLevel.LEVEL_1) {
      const unconfirmedLevel1Count = await prisma.notification.count({
        where: {
          reportId: notification.reportId,
          type: 'CRITICAL_VALUE',
          level: NotificationLevel.LEVEL_1,
          confirmedAt: null,
        },
      });

      if (unconfirmedLevel1Count === 0) {
        const report = await prisma.report.update({
          where: { id: notification.reportId },
          data: {
            isLocked: false,
            status: ReportStatus.PENDING_REVIEW,
          },
        });

        logger.info(`报告 ${report.reportNo} 一级危急值通知已全部确认，解锁并进入待审核`);

        wsManager.broadcast('report:unlocked', {
          type: 'REPORT_UNLOCKED',
          reportId: report.id,
          reportNo: report.reportNo,
          unlockedBy: confirmerId,
          notificationId,
          isLateConfirmation: wasEscalated,
          timestamp: now.toISOString(),
        });
      } else {
        logger.info(`一级危急值通知 ${notificationId} 已确认，但仍有${unconfirmedLevel1Count}个一级通知未确认，报告保持锁定`);
      }
    }

    if (notification.level !== NotificationLevel.LEVEL_1) {
      logger.info(`危急值${notification.level === NotificationLevel.LEVEL_2 ? '二级' : '三级'}通知已确认（报告${notification.report?.reportNo || notification.reportId}），仅记录处理动作`);
    }

    return confirmed;
  }

  async checkAndEscalateTimeouts() {
    const now = new Date();
    const threshold = new Date(now.getTime() - CRITICAL_TIMEOUT_MINUTES * 60 * 1000);

    const pendingNotifications = await prisma.notification.findMany({
      where: {
        type: 'CRITICAL_VALUE',
        status: { in: [NotificationStatus.SENT, NotificationStatus.READ] },
        level: { in: [NotificationLevel.LEVEL_1, NotificationLevel.LEVEL_2] },
        sentAt: { lte: threshold },
        reportId: { not: null },
        confirmedAt: null,
      },
      include: { report: true },
    });

    const results: any[] = [];

    for (const notif of pendingNotifications) {
      try {
        const result = await this.escalateNotification(notif);
        results.push(result);
      } catch (error) {
        logger.error(`危急值升级失败: ${notif.id} - ${(error as Error).message}`);
      }
    }

    return {
      scanned: pendingNotifications.length,
      escalated: results.filter(r => r.status !== 'MAX_LEVEL_REACHED' && r.status !== 'ALREADY_ESCALATED').length,
      details: results,
    };
  }

  private async escalateNotification(notification: any): Promise<any> {
    const now = new Date();

    if (notification.level === NotificationLevel.LEVEL_3) {
      return { id: notification.id, status: 'MAX_LEVEL_REACHED' };
    }

    await prisma.notification.update({
      where: { id: notification.id },
      data: {
        status: NotificationStatus.ESCALATED,
        escalatedAt: now,
      },
    });

    const report = notification.report;
    let nextLevel: NotificationLevel;
    let nextRecipients: string[] = [];

    if (notification.level === NotificationLevel.LEVEL_1) {
      nextLevel = NotificationLevel.LEVEL_2;
      const deptHeads = await prisma.user.findMany({
        where: {
          departmentId: report.departmentId,
          role: UserRole.DEPARTMENT_HEAD,
          isActive: true,
        },
        select: { id: true },
      });
      nextRecipients = deptHeads.map(u => u.id);

      if (nextRecipients.length === 0) {
        const labDirs = await prisma.user.findMany({
          where: {
            departmentId: report.departmentId,
            role: UserRole.LAB_DIRECTOR,
            isActive: true,
          },
          select: { id: true },
        });
        nextRecipients = labDirs.map(u => u.id);
      }
    } else if (notification.level === NotificationLevel.LEVEL_2) {
      nextLevel = NotificationLevel.LEVEL_3;
      const medAffairs = await prisma.user.findMany({
        where: { role: UserRole.MEDICAL_AFFAIRS, isActive: true },
        select: { id: true },
      });
      nextRecipients = medAffairs.map(u => u.id);

      if (nextRecipients.length === 0) {
        const admins = await prisma.user.findMany({
          where: { role: UserRole.ADMIN, isActive: true },
          select: { id: true },
        });
        nextRecipients = admins.map(u => u.id);
      }
    } else {
      return { id: notification.id, status: 'MAX_LEVEL_REACHED' };
    }

    const criticalItems = await prisma.testResult.findMany({
      where: {
        sample: { report: { id: report.id } },
        isCritical: true,
      },
      include: { labTest: true },
    });

    const patient = await prisma.patient.findUnique({
      where: { id: report.patientId },
      select: { name: true, mrn: true },
    });

    for (const recipientId of nextRecipients) {
      await this.createNotificationWithEscalation(recipientId, nextLevel, {
        reportId: report.id,
        reportNo: report.reportNo,
        patientName: patient?.name,
        patientMrn: patient?.mrn,
        criticalItems: criticalItems.map(r => ({
          testName: r.labTest.name,
          value: r.resultValue,
          unit: r.unit,
        })),
      }, notification.id);
    }

    return {
      id: notification.id,
      previousLevel: notification.level,
      escalatedTo: nextLevel,
      recipientsCount: nextRecipients.length,
    };
  }

  async getCriticalNotifications(params: {
    status?: NotificationStatus;
    level?: NotificationLevel;
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { status, level, startDate, endDate, page = 1, pageSize = 20 } = params;

    const where: any = { type: 'CRITICAL_VALUE' };
    if (status) where.status = status;
    if (level) where.level = level;
    if (startDate || endDate) {
      where.sentAt = {};
      if (startDate) where.sentAt.gte = startDate;
      if (endDate) where.sentAt.lte = endDate;
    }

    const [total, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { sentAt: 'desc' },
        include: {
          recipient: { select: { id: true, name: true, role: true } },
          confirmedBy: { select: { id: true, name: true, role: true } },
          report: { select: { reportNo: true, isLocked: true, status: true } },
          escalatedFrom: {
            select: {
              id: true,
              level: true,
              status: true,
              escalatedAt: true,
              confirmedAt: true,
              confirmedBy: { select: { name: true, role: true } },
              recipient: { select: { name: true, role: true } },
            },
          },
          escalatedTo: {
            select: {
              id: true,
              level: true,
              status: true,
              recipient: { select: { name: true, role: true } },
              confirmedAt: true,
              confirmedBy: { select: { name: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      data: notifications,
    };
  }
}

export const criticalValueService = new CriticalValueService();
