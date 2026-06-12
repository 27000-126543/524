import { Request, Response, NextFunction } from 'express';
import { exportService } from '../services/export.service';

export const exportTestList = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      patientId: req.query.patientId as string | undefined,
      departmentId: req.query.departmentId as string | undefined,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      format: (req.query.format as 'xlsx' | 'csv' | 'json') || 'xlsx',
    };
    const result = await exportService.exportTestList(params);

    if (result.format === 'json') {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.send(result.data);
    } else {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.send(Buffer.from(result.data as ArrayBuffer));
    }
  } catch (error) {
    next(error);
  }
};

export const exportFeeDetails = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      patientId: req.query.patientId as string | undefined,
      departmentId: req.query.departmentId as string | undefined,
      startDate: req.query.startDate ? new Date(req.query.startDate as string) : undefined,
      endDate: req.query.endDate ? new Date(req.query.endDate as string) : undefined,
      format: (req.query.format as 'xlsx' | 'csv' | 'json') || 'xlsx',
    };
    const result = await exportService.exportFeeDetails(params);

    if (result.format === 'json') {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.send(result.data);
    } else {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
      res.send(Buffer.from(result.data as ArrayBuffer));
    }
  } catch (error) {
    next(error);
  }
};
