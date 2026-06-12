import { Request, Response, NextFunction } from 'express';
import { reportDistributionService } from '../services/reportDistribution.service';

export const distributeReport = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await reportDistributionService.distributeReport(
      req.params.reportId,
      req.user.id
    );
    res.json({
      success: true,
      message: '报告已分发至临床科室',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const archiveReport = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await reportDistributionService.archiveReport(req.params.reportId);
    res.json({
      success: true,
      message: '报告已归档',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const autoArchiveReports = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await reportDistributionService.autoArchiveDistributedReports();
    res.json({
      success: true,
      message: `自动归档完成，共归档${result.archived}份报告`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getPatientReports = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await reportDistributionService.getPatientReports(
      req.params.patientId,
      params
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
