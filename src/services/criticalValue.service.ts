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

    const existingLevel1 = await prisma.notification.findMany({
      where: {
        reportId,
        type: 'CRITICAL_VALUE',
        level: NotificationLevel.LEVEL_1,
        confirmedAt: null,
      },
      include: {
        recipient: { select: { id: true, name: true, role: true } },
        confirmedBy: { select: { id: true, name: true } },
      },
    });

    const alreadySentIds = new Set(existingLevel1.map(n => n.recipientId));
    const existingPending = existingLevel1.filter(n => n.status !== NotificationStatus.ESCALATED);

    if (existingPending.length > 0 || recipients.level1.every(id => alreadySentIds.has(id))) {
      logger.info(`报告 ${report.reportNo} 已有未处理的一级危急值通知，跳过重复创建`);
      return {
        locked: report.isLocked,
        timeoutMinutes: CRITICAL_TIMEOUT_MINUTES,
        level1Total: recipients.level1.length,
        level1Pending: existingPending.length,
        level1Confirmed: existingLevel1.filter(n => n.confirmedAt).length,
        notificationsCreated: 0,
        existingNotifications: existingLevel1,
        reportId: report.id,
        duplicate: true,
      };
    }

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
    reportNo?: string;
    patientName?: string;
    confirmed?: 'true' | 'false' | 'all';
    escalated?: 'true' | 'false' | 'all';
  }) {
    const {
      status, level, startDate, endDate, page = 1, pageSize = 20,
      reportNo, patientName, confirmed = 'all', escalated = 'all',
    } = params;

    const where: any = { type: 'CRITICAL_VALUE' };
    if (status) where.status = status;
    if (level) where.level = level;
    if (startDate || endDate) {
      where.sentAt = {};
      if (startDate) where.sentAt.gte = startDate;
      if (endDate) where.sentAt.lte = endDate;
    }
    if (confirmed === 'true') where.confirmedAt = { not: null };
    if (confirmed === 'false') where.confirmedAt = null;
    if (escalated === 'true') where.status = NotificationStatus.ESCALATED;
    if (escalated === 'false') where.status = { not: NotificationStatus.ESCALATED };

    const reportWhere: any = {};
    if (reportNo) reportWhere.reportNo = { contains: reportNo, mode: 'insensitive' };

    const patientWhere: any = {};
    if (patientName) patientWhere.name = { contains: patientName, mode: 'insensitive' };

    if (reportNo || patientName) {
      where.report = {};
      if (reportNo) where.report.is = reportWhere;
      if (patientName) {
        if (where.report.is) {
          where.report.is.patient = { is: patientWhere };
        } else {
          where.report.is = { patient: { is: patientWhere } };
        }
      }
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
          report: {
            select: {
              reportNo: true, isLocked: true, status: true,
              patient: { select: { name: true, mrn: true } },
            },
          },
          escalatedFrom: {
            select: {
              id: true, level: true, status: true, escalatedAt: true,
              confirmedAt: true, confirmedBy: { select: { name: true, role: true } },
              recipient: { select: { name: true, role: true } },
            },
          },
          escalatedTo: {
            select: {
              id: true, level: true, status: true,
              recipient: { select: { name: true, role: true } },
              confirmedAt: true, confirmedBy: { select: { name: true } },
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

  async markNotificationRead(notificationId: string, userId: string) {
    const notification = await prisma.notification.findUnique({
      where: { id: notificationId },
      select: { id: true, recipientId: true, status: true, readAt: true },
    });

    if (!notification) {
      throw new NotFoundError('通知不存在');
    }

    if (notification.recipientId !== userId) {
      throw new AppError('仅通知接收人可标记已读', 403);
    }

    if (notification.readAt) {
      return notification;
    }

    if (notification.status === NotificationStatus.ESCALATED) {
      return await prisma.notification.update({
        where: { id: notificationId },
        data: { readAt: new Date() },
      });
    }

    if (notification.status === NotificationStatus.SENT) {
      return await prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: NotificationStatus.READ,
          readAt: new Date(),
        },
      });
    }

    return notification;
  }

  async getCriticalTimeline(reportId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      select: {
        id: true, reportNo: true, isLocked: true, status: true, hasCritical: true,
        generatedAt: true, approvedAt: true, reviewedAt: true,
        patient: { select: { name: true, mrn: true } },
        reviewedBy: { select: { name: true, role: true } },
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

    const notifications = await prisma.notification.findMany({
      where: { reportId, type: 'CRITICAL_VALUE' },
      orderBy: { sentAt: 'asc' },
      include: {
        recipient: { select: { id: true, name: true, role: true } },
        confirmedBy: { select: { id: true, name: true, role: true } },
      },
    });

    const events: any[] = [];

    events.push({
      timestamp: report.generatedAt,
      type: 'REPORT_GENERATED',
      title: '报告生成',
      description: `报告 ${report.reportNo} 生成${report.hasCritical ? '，检测到危急值' : ''}`,
      reportStatus: report.status,
      reportLocked: report.isLocked,
      operator: null,
    });

    if (report.isLocked || notifications.length > 0) {
      events.push({
        timestamp: report.generatedAt,
        type: 'REPORT_LOCKED',
        title: '报告锁定',
        description: '因含危急值，报告被锁定，需开单医生确认后方可审核',
        reportStatus: report.status,
        reportLocked: true,
        operator: null,
      });
    }

    for (const n of notifications) {
      events.push({
        timestamp: n.sentAt,
        type: 'NOTIFICATION_SENT',
        title: `${this.levelLabel(n.level)}通知发送`,
        description: `已通知 ${n.recipient.name}（${this.roleLabel(n.recipient.role)}）`,
        notificationId: n.id,
        level: n.level,
        reportStatus: report.status,
        reportLocked: report.isLocked,
        operator: { name: '系统', role: 'SYSTEM' },
      });

      if (n.status === NotificationStatus.ESCALATED && n.escalatedAt) {
        events.push({
          timestamp: n.escalatedAt,
          type: 'NOTIFICATION_ESCALATED',
          title: `${this.levelLabel(n.level)}通知超时升级`,
          description: `${n.recipient.name} 未在${CRITICAL_TIMEOUT_MINUTES}分钟内确认，已自动升级`,
          notificationId: n.id,
          level: n.level,
          reportStatus: report.status,
          reportLocked: report.isLocked,
          operator: { name: '系统', role: 'SYSTEM' },
        });
      }

      if (n.confirmedAt && n.confirmedBy) {
        events.push({
          timestamp: n.confirmedAt,
          type: 'NOTIFICATION_CONFIRMED',
          title: `${this.levelLabel(n.level)}通知${n.status === NotificationStatus.ESCALATED ? '补' : ''}确认`,
          description: `${n.confirmedBy.name}（${this.roleLabel(n.confirmedBy.role)}）${n.status === NotificationStatus.ESCALATED ? '补' : ''}确认了通知`,
          notificationId: n.id,
          level: n.level,
          reportStatus: report.status,
          reportLocked: report.isLocked,
          operator: n.confirmedBy,
        });
      }
    }

    if (!report.isLocked && notifications.some(n => n.level === NotificationLevel.LEVEL_1 && n.confirmedAt)) {
      const lastLevel1Confirm = notifications
        .filter(n => n.level === NotificationLevel.LEVEL_1 && n.confirmedAt)
        .sort((a, b) => (b.confirmedAt!.getTime() - a.confirmedAt!.getTime()))[0];
      if (lastLevel1Confirm && lastLevel1Confirm.confirmedAt) {
        events.push({
          timestamp: lastLevel1Confirm.confirmedAt,
          type: 'REPORT_UNLOCKED',
          title: '报告解锁',
          description: '所有一级接收人均已确认，报告解除锁定，进入待审核状态',
          reportStatus: ReportStatus.PENDING_REVIEW,
          reportLocked: false,
          operator: lastLevel1Confirm.confirmedBy,
        });
      }
    }

    if (report.status === ReportStatus.APPROVED && report.reviewedAt && report.reviewedBy) {
      events.push({
        timestamp: report.reviewedAt,
        type: 'REPORT_APPROVED',
        title: '报告审核通过',
        description: `${report.reviewedBy.name}（${this.roleLabel(report.reviewedBy.role)}）审核通过`,
        reportStatus: report.status,
        reportLocked: false,
        operator: report.reviewedBy,
      });
    }

    events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return {
      report: {
        id: report.id,
        reportNo: report.reportNo,
        isLocked: report.isLocked,
        status: report.status,
        hasCritical: report.hasCritical,
        patient: report.patient,
      },
      timeline: events,
    };
  }

  async getReportCriticalLockInfo(reportId: string) {
    const report = await prisma.report.findUnique({
      where: { id: reportId },
      select: {
        id: true, reportNo: true, isLocked: true, status: true, hasCritical: true,
      },
    });

    if (!report) {
      throw new NotFoundError('报告不存在');
    }

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

    return {
      report,
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
        escalatedAt: n.escalatedAt,
      })),
      level1Confirmed: level1Confirmed.map(n => ({
        id: n.id, recipient: n.recipient, sentAt: n.sentAt,
        confirmedAt: n.confirmedAt, confirmedBy: n.confirmedBy,
        isLate: n.status === NotificationStatus.ESCALATED,
        escalatedAt: n.escalatedAt,
      })),
      escalationProcessed: [...level2, ...level3].map(n => ({
        id: n.id,
        level: n.level,
        recipient: n.recipient,
        sentAt: n.sentAt,
        status: n.status,
        confirmedAt: n.confirmedAt,
        confirmedBy: n.confirmedBy,
        escalatedFrom: n.escalatedFrom ? { recipient: n.escalatedFrom.recipient, notificationId: n.escalatedFromId } : null,
      })),
    };
  }

  private levelLabel(level: NotificationLevel) {
    return {
      [NotificationLevel.LEVEL_1]: '一级',
      [NotificationLevel.LEVEL_2]: '二级',
      [NotificationLevel.LEVEL_3]: '三级',
    }[level];
  }

  private roleLabel(role: string) {
    const map: Record<string, string> = {
      CLINICIAN: '开单医生',
      DEPARTMENT_HEAD: '科室主任',
      LAB_DIRECTOR: '检验科主任',
      LAB_TECHNICIAN: '检验技师',
      MEDICAL_AFFAIRS: '医务科',
      ADMIN: '管理员',
    };
    return map[role] || role;
  }
}

export const criticalValueService = new CriticalValueService();
