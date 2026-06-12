import { Request, Response, NextFunction } from 'express';
import { sampleReceptionService } from '../services/sampleReception.service';
import { AuthRequest } from '../middleware/auth';

export const receiveSample = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await sampleReceptionService.receiveSample(req.body, req.user!.id);
    res.status(201).json({
      success: true,
      message: result.isIncomplete ? '样本已接收但信息不完整，已退回' : '样本接收成功，已分配科室',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getSamples = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      ...req.query,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await sampleReceptionService.getSamples(params as any);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getSampleDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await sampleReceptionService.getSampleDetail(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
