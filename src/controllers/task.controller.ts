import { Request, Response, NextFunction } from 'express';
import { taskAssignmentService } from '../services/taskAssignment.service';

export const assignTask = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await taskAssignmentService.assignTaskToDevice(req.params.taskId);
    res.json({
      success: true,
      message: '任务分配成功',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const autoAssignTasks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await taskAssignmentService.autoAssignPendingTasks(req.query.departmentId as string | undefined);
    res.json({
      success: true,
      message: `自动分配完成：共${result.total}个任务，成功${result.assigned}个，失败${result.failed}个`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const startTask = async (req: any, res: Response, next: NextFunction) => {
  try {
    const result = await taskAssignmentService.startTask(req.params.taskId, req.user.id);
    res.json({
      success: true,
      message: '任务已开始执行',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const completeTask = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await taskAssignmentService.completeTask(req.params.taskId);
    res.json({
      success: true,
      message: '任务已完成',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getTaskQueue = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = {
      ...req.query,
      page: req.query.page ? parseInt(req.query.page as string) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
    };
    const result = await taskAssignmentService.getTaskQueue(params as any);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const getDeviceLoad = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await taskAssignmentService.getDeviceLoadStatus(req.query.departmentId as string | undefined);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
