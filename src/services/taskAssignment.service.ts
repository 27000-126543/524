import prisma from '../lib/prisma';
import { DeviceStatus, SampleStatus, UrgencyLevel } from '@prisma/client';
import { NotFoundError, AppError } from '../middleware/error';
import logger from '../lib/logger';
import { wsManager } from '../lib/ws';

class TaskAssignmentService {
  async assignTaskToDevice(taskId: string): Promise<any> {
    const task = await prisma.testTask.findUnique({
      where: { id: taskId },
      include: {
        sample: true,
        labTest: true,
      },
    });

    if (!task) {
      throw new NotFoundError('检测任务不存在');
    }

    if (task.status !== 'PENDING') {
      throw new AppError('任务状态不允许分配', 400);
    }

    const suitableDevices = await this.findSuitableDevices(task.testId!);
    if (suitableDevices.length === 0) {
      throw new AppError('没有可用的检测设备', 503);
    }

    const selectedDevice = this.selectOptimalDevice(suitableDevices, task.sample.urgency);

    return await this.executeAssignment(task, selectedDevice);
  }

  async autoAssignPendingTasks(departmentId?: string) {
    const where: any = { status: 'PENDING' };
    if (departmentId) {
      where.sample = { departmentId };
    }

    const pendingTasks = await prisma.testTask.findMany({
      where,
      include: {
        sample: { select: { urgency: true, departmentId: true } },
        labTest: { select: { id: true, name: true } },
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' },
      ],
      take: 100,
    });

    const results = [];
    for (const task of pendingTasks) {
      try {
        const suitableDevices = await this.findSuitableDevices(task.testId!);
        if (suitableDevices.length > 0) {
          const selectedDevice = this.selectOptimalDevice(suitableDevices, task.sample.urgency);
          const result = await this.executeAssignment(task, selectedDevice);
          results.push({ taskId: task.id, success: true, deviceId: selectedDevice.id });
        }
      } catch (error) {
        logger.warn(`自动分配任务失败: ${task.id} - ${(error as Error).message}`);
        results.push({ taskId: task.id, success: false });
      }
    }

    return {
      total: pendingTasks.length,
      assigned: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    };
  }

  private async findSuitableDevices(testId: string) {
    const allDevices = await prisma.device.findMany({
      where: {
        status: DeviceStatus.ONLINE,
        deviceTests: {
          some: {
            testId,
            isActive: true,
          },
        },
      },
      include: {
        deviceTests: {
          where: { testId, isActive: true },
        },
      },
    });
    return allDevices.filter(d => d.currentLoad < d.maxLoad);
  }

  private selectOptimalDevice(devices: any[], urgency: UrgencyLevel) {
    const loadScores = devices.map(device => {
      const loadRatio = device.currentLoad / device.maxLoad;
      const ageScore = device.lastMaintenance
        ? (Date.now() - new Date(device.lastMaintenance).getTime()) / (1000 * 60 * 60 * 24 * 30)
        : 0;
      const failurePenalty = device.failureRate.toNumber() * 100;
      const urgencyBoost = urgency === UrgencyLevel.CRITICAL || urgency === UrgencyLevel.EMERGENCY
        ? (1 - loadRatio) * 20
        : 0;

      const score = loadRatio * 50 + ageScore * 10 + failurePenalty - urgencyBoost;
      return { device, score };
    });

    loadScores.sort((a, b) => a.score - b.score);
    return loadScores[0].device;
  }

  private async executeAssignment(task: any, device: any) {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.device.update({
        where: { id: device.id },
        data: { currentLoad: { increment: 1 } },
      });

      const updatedTask = await tx.testTask.update({
        where: { id: task.id },
        data: {
          deviceId: device.id,
          status: 'ASSIGNED',
          assignedAt: now,
        },
        include: {
          sample: { include: { patient: true } },
          labTest: true,
          device: true,
        },
      });

      await tx.sample.update({
        where: { id: task.sampleId },
        data: { status: SampleStatus.ASSIGNED },
      });

      const staff = await tx.user.findMany({
        where: {
          departmentId: device.departmentId,
          isActive: true,
          role: { in: ['LAB_TECHNICIAN'] },
        },
        select: { id: true },
      });

      wsManager.sendToUsers(staff.map(s => s.id), 'task:assigned', {
        type: 'TASK_ASSIGNED',
        taskId: updatedTask.id,
        testName: updatedTask.labTest?.name,
        deviceName: updatedTask.device?.name,
        patientName: updatedTask.sample.patient.name,
        sampleNo: updatedTask.sample.sampleNo,
        priority: task.priority,
        timestamp: now.toISOString(),
      });

      return updatedTask;
    });
  }

  async startTask(taskId: string, technicianId: string) {
    const task = await prisma.testTask.findUnique({
      where: { id: taskId },
      include: { device: true },
    });

    if (!task) {
      throw new NotFoundError('检测任务不存在');
    }

    if (task.status !== 'ASSIGNED') {
      throw new AppError('仅已分配的任务可以开始', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      const updatedTask = await tx.testTask.update({
        where: { id: taskId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: now,
        },
        include: {
          sample: true,
          labTest: true,
          device: true,
        },
      });

      await tx.sample.update({
        where: { id: task.sampleId },
        data: {
          status: SampleStatus.ANALYZING,
          analysisStartTime: now,
        },
      });

      return updatedTask;
    });
  }

  async completeTask(taskId: string) {
    const task = await prisma.testTask.findUnique({
      where: { id: taskId },
      include: { device: true },
    });

    if (!task) {
      throw new NotFoundError('检测任务不存在');
    }

    if (task.status !== 'IN_PROGRESS') {
      throw new AppError('仅进行中的任务可以完成', 400);
    }

    return await prisma.$transaction(async (tx) => {
      const now = new Date();

      if (task.deviceId) {
        await tx.device.update({
          where: { id: task.deviceId },
          data: { currentLoad: { decrement: 1 } },
        });
      }

      const updatedTask = await tx.testTask.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          completedAt: now,
        },
        include: {
          sample: true,
          labTest: true,
        },
      });

      const remainingTasks = await tx.testTask.count({
        where: {
          sampleId: task.sampleId,
          status: { not: 'COMPLETED' },
        },
      });

      if (remainingTasks === 0) {
        await tx.sample.update({
          where: { id: task.sampleId },
          data: {
            status: SampleStatus.ANALYZED,
            analysisEndTime: now,
          },
        });
      }

      return updatedTask;
    });
  }

  async getTaskQueue(params: {
    departmentId?: string;
    deviceId?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    const { departmentId, deviceId, status, page = 1, pageSize = 50 } = params;

    const where: any = {};
    if (departmentId) where.sample = { departmentId };
    if (deviceId) where.deviceId = deviceId;
    if (status) where.status = status;

    const [total, tasks] = await Promise.all([
      prisma.testTask.count({ where }),
      prisma.testTask.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [
          { priority: 'desc' },
          { createdAt: 'asc' },
        ],
        include: {
          sample: { include: { patient: { select: { name: true, mrn: true } } } },
          labTest: true,
          device: true,
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      data: tasks,
    };
  }

  async getDeviceLoadStatus(departmentId?: string) {
    const where: any = { status: { not: DeviceStatus.OFFLINE } };
    if (departmentId) where.departmentId = departmentId;

    const devices = await prisma.device.findMany({
      where,
      include: {
        department: { select: { name: true } },
        testTasks: {
          where: { status: { in: ['ASSIGNED', 'IN_PROGRESS'] } },
          select: { id: true },
        },
      },
    });

    return devices.map(device => ({
      id: device.id,
      code: device.code,
      name: device.name,
      status: device.status,
      maxLoad: device.maxLoad,
      currentLoad: device.currentLoad,
      activeTasks: device.testTasks.length,
      loadPercent: (device.currentLoad / device.maxLoad) * 100,
      failureRate: device.failureRate,
      department: device.department.name,
    }));
  }
}

export const taskAssignmentService = new TaskAssignmentService();
