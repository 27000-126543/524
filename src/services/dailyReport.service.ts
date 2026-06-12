import * as XLSX from 'xlsx';
import prisma from '../lib/prisma';
import { SampleStatus, ReportStatus, WorkOrderStatus } from '@prisma/client';
import { NotFoundError } from '../middleware/error';
import logger from '../lib/logger';

interface DailyStats {
  totalSamples: number;
  completedSamples: number;
  totalReports: number;
  approvedReports: number;
  recheckRate: number;
  criticalCount: number;
}

interface DepartmentStats extends DailyStats {
  departmentId: string;
  departmentName: string;
  tatAverageMinutes: number;
  tatTargetMinutes: number;
  tatComplianceRate: number;
}

interface DeviceStats {
  deviceId: string;
  deviceName: string;
  departmentName: string;
  totalTasks: number;
  completedTasks: number;
  failureRate: number;
  loadPercent: number;
  status: string;
}

class DailyReportService {
  async generateDailyReport(date?: Date) {
    const reportDate = date ? this.startOfDay(date) : this.startOfDay(new Date());
    const nextDay = this.addDays(reportDate, 1);

    const existing = await prisma.dailyReport.findUnique({
      where: { reportDate },
    });
    if (existing && !date) {
      return existing;
    }

    const departments = await prisma.department.findMany({
      where: { isLab: true },
    });

    const departmentStats: DepartmentStats[] = [];
    for (const dept of departments) {
      const stats = await this.calculateDepartmentStats(dept.id, reportDate, nextDay);
      departmentStats.push({
        departmentId: dept.id,
        departmentName: dept.name,
        ...stats,
      });
    }

    const overallStats = this.calculateOverallStats(departmentStats);
    const tatStats = this.calculateTatStats(departmentStats);
    const deviceStats = await this.calculateDeviceStats(reportDate, nextDay);

    const report = await prisma.dailyReport.upsert({
      where: { reportDate },
      create: {
        reportDate,
        departmentStats,
        overallStats,
        tatStats,
        deviceStats,
      },
      update: {
        departmentStats,
        overallStats,
        tatStats,
        deviceStats,
      },
    });

    logger.info(`每日运营报表生成完成: ${reportDate.toISOString().slice(0, 10)}`);
    return report;
  }

  private async calculateDepartmentStats(
    departmentId: string,
    startDate: Date,
    endDate: Date
  ): Promise<DailyStats & {
    tatAverageMinutes: number;
    tatTargetMinutes: number;
    tatComplianceRate: number;
  }> {
    const baseWhere = {
      departmentId,
      receivedAt: { gte: startDate, lt: endDate },
    };

    const [totalSamples, completedSamples, recheckOrders, allResults] = await Promise.all([
      prisma.sample.count({ where: baseWhere }),
      prisma.sample.count({
        where: {
          ...baseWhere,
          status: { in: [SampleStatus.REPORTED, SampleStatus.ARCHIVED] },
        },
      }),
      prisma.workOrder.count({
        where: {
          departmentId,
          type: 'RECHECK',
          createdAt: { gte: startDate, lt: endDate },
        },
      }),
      prisma.testResult.findMany({
        where: {
          sample: { departmentId },
          createdAt: { gte: startDate, lt: endDate },
        },
        select: { isCritical: true, isRecheck: true },
      }),
    ]);

    const totalReports = await prisma.report.count({
      where: {
        departmentId,
        generatedAt: { gte: startDate, lt: endDate },
      },
    });

    const approvedReports = await prisma.report.count({
      where: {
        departmentId,
        approvedAt: { gte: startDate, lt: endDate },
        status: { in: [ReportStatus.APPROVED, ReportStatus.DISTRIBUTED, ReportStatus.ARCHIVED] },
      },
    });

    const criticalCount = allResults.filter(r => r.isCritical).length;
    const totalWithRecheck = allResults.length + recheckOrders;
    const recheckRate = totalWithRecheck > 0 ? (recheckOrders / totalWithRecheck) * 100 : 0;

    const { avgTat, complianceRate, target } = await this.calculateTAT(
      departmentId, startDate, endDate
    );

    return {
      totalSamples,
      completedSamples,
      totalReports,
      approvedReports,
      recheckRate,
      criticalCount,
      tatAverageMinutes: avgTat,
      tatTargetMinutes: target,
      tatComplianceRate: complianceRate,
    };
  }

  private async calculateTAT(
    departmentId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{ avgTat: number; complianceRate: number; target: number }> {
    const target = 60;

    const samples = await prisma.sample.findMany({
      where: {
        departmentId,
        receivedAt: { gte: startDate, lt: endDate },
        analysisEndTime: { not: null },
      },
      select: {
        receivedAt: true,
        analysisEndTime: true,
      },
    });

    if (samples.length === 0) {
      return { avgTat: 0, complianceRate: 0, target };
    }

    const tats = samples.map(s =>
      (s.analysisEndTime!.getTime() - s.receivedAt.getTime()) / (1000 * 60)
    );

    const avgTat = tats.reduce((a, b) => a + b, 0) / tats.length;
    const onTimeCount = tats.filter(t => t <= target).length;
    const complianceRate = (onTimeCount / tats.length) * 100;

    return { avgTat: Math.round(avgTat * 100) / 100, complianceRate, target };
  }

  private calculateOverallStats(departmentStats: DepartmentStats[]): DailyStats & {
    averageRecheckRate: number;
    sampleCompletionRate: number;
    reportApprovalRate: number;
  } {
    const sum = departmentStats.reduce(
      (acc, d) => ({
        totalSamples: acc.totalSamples + d.totalSamples,
        completedSamples: acc.completedSamples + d.completedSamples,
        totalReports: acc.totalReports + d.totalReports,
        approvedReports: acc.approvedReports + d.approvedReports,
        recheckRate: acc.recheckRate + d.recheckRate,
        criticalCount: acc.criticalCount + d.criticalCount,
      }),
      { totalSamples: 0, completedSamples: 0, totalReports: 0, approvedReports: 0, recheckRate: 0, criticalCount: 0 }
    );

    return {
      ...sum,
      averageRecheckRate: departmentStats.length > 0
        ? sum.recheckRate / departmentStats.length : 0,
      sampleCompletionRate: sum.totalSamples > 0
        ? (sum.completedSamples / sum.totalSamples) * 100 : 0,
      reportApprovalRate: sum.totalReports > 0
        ? (sum.approvedReports / sum.totalReports) * 100 : 0,
    };
  }

  private calculateTatStats(departmentStats: DepartmentStats[]) {
    const tats = departmentStats.map(d => d.tatAverageMinutes).filter(t => t > 0);
    const compliances = departmentStats.map(d => d.tatComplianceRate);

    return {
      overallAverageMinutes: tats.length > 0
        ? tats.reduce((a, b) => a + b, 0) / tats.length : 0,
      overallComplianceRate: compliances.length > 0
        ? compliances.reduce((a, b) => a + b, 0) / compliances.length : 0,
      departments: departmentStats.map(d => ({
        departmentName: d.departmentName,
        tatAverageMinutes: d.tatAverageMinutes,
        tatComplianceRate: d.tatComplianceRate,
        tatTargetMinutes: d.tatTargetMinutes,
      })),
    };
  }

  private async calculateDeviceStats(startDate: Date, endDate: Date): Promise<DeviceStats[]> {
    const devices = await prisma.device.findMany({
      include: {
        department: { select: { name: true } },
        testTasks: {
          where: {
            createdAt: { gte: startDate, lt: endDate },
          },
          select: { status: true },
        },
      },
    });

    return devices.map(d => {
      const total = d.testTasks.length;
      const completed = d.testTasks.filter(t => t.status === 'COMPLETED').length;
      return {
        deviceId: d.id,
        deviceName: d.name,
        departmentName: d.department.name,
        totalTasks: total,
        completedTasks: completed,
        failureRate: d.failureRate.toNumber() * 100,
        loadPercent: (d.currentLoad / d.maxLoad) * 100,
        status: d.status,
      };
    });
  }

  async exportDailyReport(date: Date, format: 'xlsx' | 'csv') {
    const reportDate = this.startOfDay(date);
    const report = await prisma.dailyReport.findUnique({
      where: { reportDate },
    });

    if (!report) {
      throw new NotFoundError(`指定日期 ${reportDate.toISOString().slice(0, 10)} 的报表不存在`);
    }

    const deptStats = report.departmentStats as unknown as DepartmentStats[];
    const deviceStats = report.deviceStats as unknown as DeviceStats[];
    const overall = report.overallStats as any;

    const wb = XLSX.utils.book_new();

    const overviewSheet = XLSX.utils.json_to_sheet([{
      报表日期: reportDate.toISOString().slice(0, 10),
      总样本数: overall.totalSamples,
      已完成样本: overall.completedSamples,
      样本完成率: `${overall.sampleCompletionRate?.toFixed(2) || 0}%`,
      总报告数: overall.totalReports,
      已审核报告: overall.approvedReports,
      报告审核率: `${overall.reportApprovalRate?.toFixed(2) || 0}%`,
      平均复检率: `${overall.averageRecheckRate?.toFixed(2) || 0}%`,
      危急值总数: overall.criticalCount,
      生成时间: report.generatedAt.toISOString(),
    }]);
    XLSX.utils.book_append_sheet(wb, overviewSheet, '总体概览');

    const deptSheetData = deptStats.map(d => ({
      科室: d.departmentName,
      接收样本数: d.totalSamples,
      完成样本数: d.completedSamples,
      生成报告数: d.totalReports,
      审核通过报告数: d.approvedReports,
      复检率: `${d.recheckRate.toFixed(2)}%`,
      危急值数: d.criticalCount,
      平均TAT(分钟): d.tatAverageMinutes,
      TAT目标(分钟): d.tatTargetMinutes,
      TAT达标率: `${d.tatComplianceRate.toFixed(2)}%`,
    }));
    const deptSheet = XLSX.utils.json_to_sheet(deptSheetData);
    XLSX.utils.book_append_sheet(wb, deptSheet, '科室统计');

    const deviceSheetData = deviceStats.map(d => ({
      设备名称: d.deviceName,
      所属科室: d.departmentName,
      总任务数: d.totalTasks,
      已完成任务: d.completedTasks,
      故障率: `${d.failureRate.toFixed(2)}%`,
      当前负载率: `${d.loadPercent.toFixed(2)}%`,
      设备状态: this.translateDeviceStatus(d.status),
    }));
    const deviceSheet = XLSX.utils.json_to_sheet(deviceSheetData);
    XLSX.utils.book_append_sheet(wb, deviceSheet, '设备统计');

    const filename = `实验室运营日报_${reportDate.toISOString().slice(0, 10)}`;
    const data = XLSX.write(wb, {
      type: 'buffer',
      bookType: format === 'csv' ? 'csv' : 'xlsx',
    });

    return {
      filename: `${filename}.${format === 'csv' ? 'csv' : 'xlsx'}`,
      contentType: format === 'csv'
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data,
    };
  }

  async getDailyReports(params: {
    startDate?: Date;
    endDate?: Date;
    page?: number;
    pageSize?: number;
  }) {
    const { startDate, endDate, page = 1, pageSize = 30 } = params;

    const where: any = {};
    if (startDate || endDate) {
      where.reportDate = {};
      if (startDate) where.reportDate.gte = this.startOfDay(startDate);
      if (endDate) where.reportDate.lte = this.addDays(this.startOfDay(endDate), 1);
    }

    const [total, reports] = await Promise.all([
      prisma.dailyReport.count({ where }),
      prisma.dailyReport.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { reportDate: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      data: reports,
    };
  }

  private startOfDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private addDays(date: Date, days: number): Date {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  private translateDeviceStatus(status: string): string {
    const map: Record<string, string> = {
      ONLINE: '在线',
      OFFLINE: '离线',
      MAINTENANCE: '维护中',
      ERROR: '故障',
    };
    return map[status] || status;
  }
}

export const dailyReportService = new DailyReportService();
