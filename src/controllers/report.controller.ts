import { Request, Response, NextFunction } from 'express';
import { reportService } from '../services/report.service';

export const generateReport = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await reportService.generateReport(req.params.sampleId, req.user.id);
    res.status(201).json({
      success: true,
      message: result.validation.passed
        ? '报告生成成功，待审核'
        : '报告生成成功，但逻辑校验未通过，已标记草稿',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const reviewReport = async (req: any, res: Response, next: NextFunction) => {
  try {
    const { action, comment } = req.body;
    const result = await reportService.reviewReport(
      req.params.reportId,
      req.user.id,
      action,
      comment
    );
    res.json({
      success: true,
      message: result.action === 'APPROVE' ? '报告审核通过' : '报告已驳回',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const fixDraftReport = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await reportService.fixDraftReport(req.params.reportId, req.user.id);
    res.json({
      success: true,
      message: '草稿报告已提交审核',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await reportService.getReport(req.params.reportId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getReports = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      ...req.query,
      hasCritical: req.query.hasCritical === 'true',
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await reportService.getReports(params as any);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
