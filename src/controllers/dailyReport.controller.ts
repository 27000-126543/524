import { Request, Response, NextFunction } from 'express';
import { dailyReportService } from '../services/dailyReport.service';

export const generateDailyReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    const result = await dailyReportService.generateDailyReport(date);
    res.json({
      success: true,
      message: '每日报表生成成功',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getDailyReports = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await dailyReportService.getDailyReports(params);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const exportDailyReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = new Date(req.params.date as string);
    const format = (req.query.format as 'xlsx' | 'csv') || 'xlsx';
    const result = await dailyReportService.exportDailyReport(date, format);

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    res.send(Buffer.from(result.data as ArrayBuffer));
  } catch (error) {
    next(error);
  }
};
