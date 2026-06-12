import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { UserRole } from '@prisma/client';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    role: UserRole;
    departmentId?: string;
  };
}

export const authenticate = async (
  req: AuthRequest, res: Response, next: NextFunction
) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: '未提供认证令牌' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, departmentId: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: '用户不存在或已禁用' });
    }

    req.user = {
      id: user.id,
      role: user.role,
      departmentId: user.departmentId || undefined,
    };
    next();
  } catch (error) {
    return res.status(401).json({ message: '认证失败' });
  }
};

export const requireRoles = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: '权限不足' });
    }
    next();
  };
};

export const requireDepartment = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user?.departmentId) {
    return res.status(403).json({ message: '用户未分配科室' });
  }
  next();
};
