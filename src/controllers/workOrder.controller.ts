import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { WorkOrderStatus } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';

export const getWorkOrders = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, status, departmentId, assignedToId, page = '1', pageSize = '20' } = req.query;

    const where: any = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (departmentId) where.departmentId = departmentId;
    if (assignedToId) where.assignedToId = assignedToId;

    const [total, orders] = await Promise.all([
      prisma.workOrder.count({ where }),
      prisma.workOrder.findMany({
        where,
        skip: (parseInt(page as string) - 1) * parseInt(pageSize as string),
        take: parseInt(pageSize as string),
        orderBy: [
          { priority: 'desc' },
          { createdAt: 'desc' },
        ],
        include: {
          assignedTo: { select: { name: true, role: true } },
          createdBy: { select: { name: true } },
          department: { select: { name: true } },
          report: { select: { reportNo: true } },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page as string),
        pageSize: parseInt(pageSize as string),
        data: orders,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getWorkOrderDetail = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const order = await prisma.workOrder.findUnique({
      where: { id: req.params.id },
      include: {
        assignedTo: { select: { name: true, role: true } },
        createdBy: { select: { name: true } },
        department: { select: { name: true } },
        report: { include: { sample: { include: { patient: true } } } },
      },
    });

    if (!order) {
      throw new NotFoundError('工单不存在');
    }

    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const completeWorkOrder = async (req: any, res: Response, next: NextFunction) => {
  try {
    const { completedNote } = req.body;
    const order = await prisma.workOrder.findUnique({ where: { id: req.params.id } });

    if (!order) {
      throw new NotFoundError('工单不存在');
    }

    if (order.status === WorkOrderStatus.COMPLETED) {
      throw new AppError('工单已完成', 400);
    }

    const result = await prisma.workOrder.update({
      where: { id: req.params.id },
      data: {
        status: WorkOrderStatus.COMPLETED,
        completedAt: new Date(),
        completedNote,
      },
    });

    res.json({
      success: true,
      message: '工单已完成',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
