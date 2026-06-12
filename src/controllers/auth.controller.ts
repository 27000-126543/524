import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { ValidationError, NotFoundError } from '../middleware/error';

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new ValidationError('用户名和密码不能为空');
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { department: { select: { id: true, name: true } } },
    });

    if (!user || !user.isActive) {
      throw new ValidationError('用户名或密码错误');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new ValidationError('用户名或密码错误');
    }

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
        departmentId: user.departmentId,
      },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '24h') as any }
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          department: user.department,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getProfile = async (req: any, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        department: { select: { id: true, name: true, code: true } },
        isActive: true,
      },
    });

    if (!user) {
      throw new NotFoundError('用户不存在');
    }

    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

export const getMyNotifications = async (req: any, res: Response, next: NextFunction) => {
  try {
    const { page = '1', pageSize = '20', status, type } = req.query;

    const where: any = { recipientId: req.user.id };
    if (status) where.status = status;
    if (type) where.type = type;

    const [total, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.findMany({
        where,
        skip: (parseInt(page as string) - 1) * parseInt(pageSize as string),
        take: parseInt(pageSize as string),
        orderBy: { sentAt: 'desc' },
        include: {
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
        data: notifications,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const markNotificationRead = async (req: any, res: Response, next: NextFunction) => {
  try {
    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });

    if (!notification) {
      throw new NotFoundError('通知不存在');
    }

    if (notification.recipientId !== req.user.id) {
      throw new ValidationError('无权操作此通知');
    }

    const result = await prisma.notification.update({
      where: { id: req.params.id },
      data: { readAt: new Date(), status: 'READ' },
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
