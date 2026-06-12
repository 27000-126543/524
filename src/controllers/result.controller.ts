import { Request, Response, NextFunction } from 'express';
import { resultUploadService } from '../services/resultUpload.service';

export const uploadResult = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resultUploadService.uploadResult(req.body);
    res.status(201).json({
      success: true,
      message: result.recheckRequired
        ? '结果上传成功，已触发复检工单'
        : '结果上传成功',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getSampleResults = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await resultUploadService.getSampleResults(req.params.sampleId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getAbnormalResults = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      ...req.query,
      criticalOnly: req.query.criticalOnly === 'true',
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await resultUploadService.getAbnormalResults(params as any);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
