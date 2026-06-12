import { Request, Response, NextFunction } from 'express';
import { criticalValueService } from '../services/criticalValue.service';

export const triggerCriticalAlert = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.handleCriticalValueDetected(req.params.reportId);
    const message = (result as any).duplicate
      ? `报告已有未完成危急值通知，返回当前状态。${(result as any).timeoutMinutes}分钟未确认将自动升级`
      : `危急值通知已发送，报告已锁定。${(result as any).timeoutMinutes}分钟未确认将自动升级`;
    res.json({
      success: true,
      message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const confirmCriticalNotification = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.confirmCriticalNotification(
      req.params.notificationId,
      req.user.id
    );
    res.json({
      success: true,
      message: '危急值通知已确认',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const markNotificationRead = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.markNotificationRead(
      req.params.notificationId,
      req.user.id
    );
    res.json({
      success: true,
      message: '通知已标记已读',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const runEscalationCheck = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.checkAndEscalateTimeouts();
    res.json({
      success: true,
      message: `危急值超时检查完成：扫描${result.scanned}条，升级${result.escalated}条`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getCriticalNotifications = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      ...req.query,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await criticalValueService.getCriticalNotifications(params as any);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getCriticalTimeline = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.getCriticalTimeline(req.params.reportId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getReportCriticalLockInfo = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await criticalValueService.getReportCriticalLockInfo(req.params.reportId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
